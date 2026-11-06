import { createHash, createSecretKey, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { Result } from "better-result";
import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { gmSession } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { keySlot, type KeySlotKind } from "@/lib/db/vault-schema";
import { SecretBox } from "@/lib/secret-box";
import { Base64Url } from "./base64url";
import type { VaultConfig } from "./config";
import { Dek } from "./dek";
import {
  KeySlotConsumedError,
  KeySlotInvalidError,
  VaultErrors,
  type KeySlotRejection,
  type VaultStorageError,
} from "./errors";

/**
 * Key slots: copies of a user's DEK wrapped under a key-encryption key that
 * needs both a client-held secret and the server's KEY_PEPPER
 * (docs/security.md "Key hierarchy"):
 *
 *   KEK      = HKDF-SHA256(ikm = secret, salt = pepper, info = "openrcs/kek/v1|" + kind + "|" + slotId)
 *   verifier = base64url(SHA-256(HKDF-SHA256(ikm = secret, salt = pepper, info = "openrcs/verifier/v1|" + slotId)))
 *   wrapped  = AES-256-GCM(KEK, DEK, AAD = userId|kind|slotId|dekId), envelope version "k1"
 *
 * The database only ever sees the verifier and the wrapped DEK. Once a slot
 * can no longer be used (consumed, revoked or expired) its wrapped DEK is
 * overwritten with `TOMBSTONE`, so an old credential plus a later database
 * and KEY_PEPPER leak reveals nothing. The row itself (id, verifier, grant,
 * consumed/revoked times) stays for replay detection.
 */

const SLOT_ID_BYTES = 16;
const SLOT_SECRET_BYTES = 32;
const KEY_BYTES = 32;
const WRAP_VERSION = "k1";
/** `wrapped_dek` of a slot whose key share was destroyed. Never unwraps. */
const TOMBSTONE = "";

export type KeySlotRow = typeof keySlot.$inferSelect;
export type NewKeySlot = typeof keySlot.$inferInsert & {
  readonly id: string;
  readonly userId: string;
  readonly kind: KeySlotKind;
  readonly dekId: string;
};

/** What a client holds for one slot. The secret never reaches the database or logs. */
export type SlotCredential = { readonly slotId: string; readonly secret: Uint8Array };

const slotIdPattern = /^[A-Za-z0-9_-]{22}$/;

export const SlotCredential = {
  generate: (): SlotCredential => ({
    slotId: Base64Url.encode(randomBytes(SLOT_ID_BYTES)),
    secret: new Uint8Array(randomBytes(SLOT_SECRET_BYTES)),
  }),
  /** `<prefix><slotId>.<base64url secret>`, e.g. a device cookie value or "ort_..." refresh token. */
  format: (prefix: string, credential: SlotCredential): string =>
    `${prefix}${credential.slotId}.${Base64Url.encode(credential.secret)}`,
  /** Strict inverse of `format`; `undefined` for anything else. */
  parse: (prefix: string, value: string): SlotCredential | undefined => {
    if (!value.startsWith(prefix)) return undefined;
    const parts = value.slice(prefix.length).split(".");
    if (parts.length !== 2) return undefined;
    const [slotId, secretPart] = parts;
    if (!slotIdPattern.test(slotId) || Base64Url.decode(slotId) === undefined) return undefined;
    const secret = Base64Url.decode(secretPart);
    if (!secret || secret.byteLength !== SLOT_SECRET_BYTES) return undefined;
    return { slotId, secret };
  },
} as const;

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array =>
  new Uint8Array(hkdfSync("sha256", ikm, salt, info, KEY_BYTES));

const deriveKek = (pepper: Uint8Array, kind: KeySlotKind, credential: SlotCredential) =>
  hkdf(credential.secret, pepper, `openrcs/kek/v1|${kind}|${credential.slotId}`);

const verifierFor = (pepper: Uint8Array, credential: SlotCredential): string =>
  Base64Url.encode(
    createHash("sha256")
      .update(hkdf(credential.secret, pepper, `openrcs/verifier/v1|${credential.slotId}`))
      .digest(),
  );

const wrapAad = (userId: string, kind: KeySlotKind, slotId: string, dekId: string) =>
  `${userId}|${kind}|${slotId}|${dekId}`;

/** Constant-time string equality (length differences return early; lengths are not secret). */
const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
};

export type MintSlotInput = {
  readonly userId: string;
  readonly kind: KeySlotKind;
  readonly dek: Dek;
  readonly grantId?: string | null;
  readonly payloadJson?: string | null;
  /** Unix epoch ms, or null for no expiry. */
  readonly expiresAt: number | null;
};

/** Creates a new slot in memory: the row to insert and the credential to hand to the client. */
const mint = (
  config: VaultConfig,
  input: MintSlotInput,
): { readonly values: NewKeySlot; readonly credential: SlotCredential } => {
  const credential = SlotCredential.generate();
  const kek = createSecretKey(deriveKek(config.pepper, input.kind, credential));
  const wrappedDek = SecretBox.sealBytes({ key: kek }, input.dek.bytes, {
    associatedData: wrapAad(input.userId, input.kind, credential.slotId, input.dek.id),
    version: WRAP_VERSION,
  });
  return {
    credential,
    values: {
      id: credential.slotId,
      userId: input.userId,
      kind: input.kind,
      dekId: input.dek.id,
      verifier: verifierFor(config.pepper, credential),
      wrappedDek,
      grantId: input.grantId ?? null,
      payloadJson: input.payloadJson ?? null,
      createdAt: config.now(),
      expiresAt: input.expiresAt,
    },
  };
};

const invalid = (row: { id: string; kind: KeySlotKind }, reason: KeySlotRejection) =>
  new KeySlotInvalidError({
    slotId: row.id,
    kind: row.kind,
    reason,
    message: `Key slot ${row.id} (${row.kind}) cannot be used: ${reason.replace(/_/g, " ")}. Nothing was changed.`,
  });

/** Checks the secret against the stored verifier (constant time). */
const verify = (
  config: VaultConfig,
  row: KeySlotRow,
  credential: SlotCredential,
): Result<void, KeySlotInvalidError> => {
  if (credential.slotId !== row.id) return Result.err(invalid(row, "not_found"));
  if (!constantTimeEqual(verifierFor(config.pepper, credential), row.verifier)) {
    return Result.err(invalid(row, "wrong_secret"));
  }
  return Result.ok();
};

/** Checks the secret against the stored verifier and unwraps the DEK. */
const unwrap = (
  config: VaultConfig,
  row: KeySlotRow,
  credential: SlotCredential,
): Result<Dek, KeySlotInvalidError> => {
  const verified = verify(config, row, credential);
  if (verified.isErr()) return Result.err(verified.error);
  if (row.wrappedDek === TOMBSTONE) return Result.err(invalid(row, "unwrap_failed"));
  const kek = createSecretKey(deriveKek(config.pepper, row.kind, credential));
  const opened = SecretBox.openBytes({ key: kek }, row.wrappedDek, {
    associatedData: wrapAad(row.userId, row.kind, row.id, row.dekId),
    version: WRAP_VERSION,
  });
  if (opened.isErr()) return Result.err(invalid(row, "unwrap_failed"));
  const dek = Dek.fromBytes(row.dekId, opened.value);
  return dek ? Result.ok(dek) : Result.err(invalid(row, "unwrap_failed"));
};

/** Lifecycle checks on a slot whose secret already verified. */
const checkState = (
  row: KeySlotRow,
  now: number,
): Result<void, KeySlotInvalidError | KeySlotConsumedError> => {
  if (row.revokedAt !== null) return Result.err(invalid(row, "revoked"));
  if (row.consumedAt !== null) {
    return Result.err(
      new KeySlotConsumedError({
        slotId: row.id,
        kind: row.kind,
        grantId: row.grantId,
        consumedAt: row.consumedAt,
        message: `Key slot ${row.id} (${row.kind}) was already used at ${new Date(row.consumedAt).toISOString()}.`,
      }),
    );
  }
  if (row.expiresAt !== null && row.expiresAt <= now) return Result.err(invalid(row, "expired"));
  return Result.ok();
};

const load = (db: Database, slotId: string): Promise<Result<KeySlotRow | null, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db.select().from(keySlot).where(eq(keySlot.id, slotId)).limit(1);
      return row ?? null;
    },
    catch: (cause) => VaultErrors.storage(`load key slot ${slotId}`, null, cause),
  });

/** Overwrites the key share of `row` (the row stays for replay detection). */
const destroy = (db: Database, row: KeySlotRow): Promise<Result<void, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.update(keySlot).set({ wrappedDek: TOMBSTONE }).where(eq(keySlot.id, row.id));
    },
    catch: (cause) => VaultErrors.storage(`destroy key share of slot ${row.id}`, row.userId, cause),
  });

/**
 * Destroys the key share of every expired slot of the user. Called on the
 * user's own token and consent writes, so codes that were never redeemed and
 * refresh tokens that were never used again do not keep a usable copy.
 */
const destroyExpired = (
  db: Database,
  userId: string,
  now: number,
): Promise<Result<void, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db
        .update(keySlot)
        .set({ wrappedDek: TOMBSTONE })
        .where(
          and(
            eq(keySlot.userId, userId),
            isNotNull(keySlot.expiresAt),
            lte(keySlot.expiresAt, now),
            ne(keySlot.wrappedDek, TOMBSTONE),
          ),
        );
    },
    catch: (cause) => VaultErrors.storage("destroy key shares of expired slots", userId, cause),
  });

/** The DEK generation of the user's paired session, or null when not paired. */
const sessionDekId = (
  db: Database,
  userId: string,
): Promise<Result<string | null, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select({ dekId: gmSession.dekId })
        .from(gmSession)
        .where(eq(gmSession.userId, userId))
        .limit(1);
      return row?.dekId ?? null;
    },
    catch: (cause) => VaultErrors.storage("read gm_session dek_id", userId, cause),
  });

export type OpenSlotInput = {
  readonly credential: SlotCredential;
  readonly kind: KeySlotKind;
  /** When set, the slot must belong to this user. */
  readonly userId?: string;
};

export type OpenedSlot = { readonly row: KeySlotRow; readonly dek: Dek };

/**
 * Loads a slot and returns its DEK if the credential is genuine and the slot
 * is usable: right kind and user, correct secret (constant-time verifier
 * check), not revoked, not consumed, not expired, and for the same DEK
 * generation as the user's gm_session (when one exists). Lifecycle checks run
 * before unwrapping, so a consumed slot whose key share is gone still reports
 * KeySlotConsumedError (replay detection). An expired slot's key share is
 * destroyed when it is presented.
 */
const open = async (
  db: Database,
  config: VaultConfig,
  input: OpenSlotInput,
): Promise<Result<OpenedSlot, KeySlotInvalidError | KeySlotConsumedError | VaultStorageError>> => {
  const loaded = await load(db, input.credential.slotId);
  if (loaded.isErr()) return Result.err(loaded.error);
  const row = loaded.value;
  if (!row) return Result.err(invalid({ id: input.credential.slotId, kind: input.kind }, "not_found"));
  if (row.kind !== input.kind) return Result.err(invalid(row, "wrong_kind"));
  const verified = verify(config, row, input.credential);
  if (verified.isErr()) return Result.err(verified.error);
  if (input.userId !== undefined && row.userId !== input.userId) {
    return Result.err(invalid(row, "wrong_user"));
  }
  const state = checkState(row, config.now());
  if (state.isErr()) {
    if (state.error._tag === "KeySlotInvalidError" && state.error.reason === "expired" && row.wrappedDek !== TOMBSTONE) {
      const destroyed = await destroy(db, row);
      if (destroyed.isErr()) return Result.err(destroyed.error);
    }
    return Result.err(state.error);
  }
  const currentDekId = await sessionDekId(db, row.userId);
  if (currentDekId.isErr()) return Result.err(currentDekId.error);
  if (currentDekId.value !== null && currentDekId.value !== row.dekId) {
    return Result.err(invalid(row, "stale_key"));
  }
  const dek = unwrap(config, row, input.credential);
  if (dek.isErr()) return Result.err(dek.error);
  return Result.ok({ row, dek: dek.value });
};

export const KeySlot = {
  TOMBSTONE,
  mint,
  verify,
  unwrap,
  checkState,
  load,
  open,
  destroyExpired,
  sessionDekId,
  verifierFor,
  constantTimeEqual,
} as const;

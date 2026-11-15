import { createSecretKey, hkdfSync } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { userKey } from "@/lib/db/vault-schema";
import { SecretBox } from "@/lib/secret-box";
import { VaultConfig } from "./config";
import { Dek } from "./dek";
import { VaultErrors, type VaultStorageError } from "./errors";

/**
 * The server's copy of a user's DEK (docs/security.md "Key hierarchy"), so
 * the server can open the user's data with no client connected:
 *
 *   KEK     = HKDF-SHA256(ikm = KEY_PEPPER, salt = "", info = "openrcs/server-kek/v1|" + JSON[userId, dekId])
 *   wrapped = AES-256-GCM(KEK, DEK, AAD = JSON["openrcs/user-key", userId, dekId]), envelope version "s1"
 *
 * One row per user in `user_key`. The KEK and AAD bind the envelope to its
 * user and DEK id, so a row copied to another user, or given another dek_id,
 * does not open.
 */

const WRAP_VERSION = "s1";
const KEY_BYTES = 32;

/** The stored key exists but does not open with this server's KEY_PEPPER. */
export class ServerKeyInvalidError extends TaggedError("ServerKeyInvalidError")<{
  userId: string;
  dekId: string;
  message: string;
}> {}

const kekFor = (pepper: Uint8Array, userId: string, dekId: string) =>
  createSecretKey(
    new Uint8Array(
      hkdfSync("sha256", pepper, new Uint8Array(0), `openrcs/server-kek/v1|${JSON.stringify([userId, dekId])}`, KEY_BYTES),
    ),
  );

const aadFor = (userId: string, dekId: string) => JSON.stringify(["openrcs/user-key", userId, dekId]);

/** The `user_key` row for `dek` (in memory; nothing is stored). */
const wrap = (config: VaultConfig, userId: string, dek: Dek) => ({
  userId,
  dekId: dek.id,
  wrappedDek: SecretBox.sealBytes({ key: kekFor(config.pepper, userId, dek.id) }, dek.bytes, {
    associatedData: aadFor(userId, dek.id),
    version: WRAP_VERSION,
  }),
  createdAt: config.now(),
});

const invalid = (userId: string, dekId: string) =>
  new ServerKeyInvalidError({
    userId,
    dekId,
    message: `The stored key of user ${userId} (dek ${dekId}) does not open with this server's KEY_PEPPER: the pepper changed or the row was modified. Nothing was decrypted or changed. Pairing the phone again replaces the key (stored messages are then deleted and synced again).`,
  });

/** Opens a `user_key` row. Pure; exported for tests. */
const unwrap = (
  config: VaultConfig,
  row: { readonly userId: string; readonly dekId: string; readonly wrappedDek: string },
): Result<Dek, ServerKeyInvalidError> => {
  const opened = SecretBox.openBytes({ key: kekFor(config.pepper, row.userId, row.dekId) }, row.wrappedDek, {
    associatedData: aadFor(row.userId, row.dekId),
    version: WRAP_VERSION,
  });
  const dek = opened.isOk() ? Dek.fromBytes(row.dekId, opened.value) : undefined;
  return dek ? Result.ok(dek) : Result.err(invalid(row.userId, row.dekId));
};

const unlockWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
): Promise<Result<Dek | null, ServerKeyInvalidError | VaultStorageError>> => {
  const loaded = await Result.tryPromise({
    try: async () => {
      const [row] = await db.select().from(userKey).where(eq(userKey.userId, userId)).limit(1);
      return row ?? null;
    },
    catch: (cause) => VaultErrors.storage("load server key", userId, cause),
  });
  if (loaded.isErr()) return Result.err(loaded.error);
  return loaded.value === null ? Result.ok(null) : unwrap(config, loaded.value);
};

/** Mints a new DEK and stores its server copy, replacing any older key of the user. */
const createWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
): Promise<Result<Dek, VaultStorageError>> => {
  const dek = Dek.generate();
  const row = wrap(config, userId, dek);
  return Result.tryPromise({
    try: async () => {
      await db
        .insert(userKey)
        .values(row)
        .onConflictDoUpdate({ target: userKey.userId, set: { dekId: row.dekId, wrappedDek: row.wrappedDek, createdAt: row.createdAt } });
      return dek;
    },
    catch: (cause) => VaultErrors.storage("store server key", userId, cause),
  });
};

/** Deletes the user's key (unpair). Data sealed under it can no longer be opened. */
const remove = (db: Database, userId: string): Promise<Result<void, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.delete(userKey).where(eq(userKey.userId, userId));
    },
    catch: (cause) => VaultErrors.storage("delete server key", userId, cause),
  });

export const ServerKey = {
  /** The user's DEK, or null when the user has no key (never paired, or unpaired). */
  unlock: (db: Database, userId: string) => unlockWith(db, VaultConfig.fromEnv(), userId),
  create: (db: Database, userId: string) => createWith(db, VaultConfig.fromEnv(), userId),
  delete: remove,
  unlockWith,
  createWith,
  wrap,
  unwrap,
} as const;

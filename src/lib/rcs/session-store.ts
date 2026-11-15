import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { gmSession, type GmSessionKind, type GmSessionStatus } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { AuthData } from "@/lib/gm/auth-data";
import { DataBox, type DataBoxAad } from "@/lib/vault/data-box";
import type { RcsContext } from "./context";
import {
  RcsKeyMismatchError,
  RcsNotPairedError,
  RcsSessionCorruptError,
  RcsStorageError,
} from "./errors";

/**
 * Persistence of the user's Google Messages session (`gm_session`).
 * `auth_data_enc` is `AuthData.serialize` sealed with the user's DEK under the
 * contract AAD (docs/vault-contract.md). `dek_id` must equal the caller's DEK
 * id (the user's server key): on a mismatch nothing is decrypted.
 */
export type GmSessionRecord = {
  readonly userId: string;
  readonly kind: GmSessionKind;
  readonly status: GmSessionStatus;
  readonly dekId: string;
  readonly phoneLabel: string | null;
  readonly lastConnectedAt: Date | null;
  readonly lastError: string | null;
};

export type LoadedSession = GmSessionRecord & { readonly authData: AuthData };

/**
 * What happened when we last used the session. Drives status transitions:
 * `authExpired` (GMAuthExpiredError, HTTP 401/403), `listenFatal` and
 * `gaiaLoggedOut` move a paired session to `needs_repair`; a successful
 * connection keeps it `paired` (with `error` set when Google answered but the
 * phone did not); `failed` (could not connect, e.g. network) keeps the
 * status; `unpaired` marks it unusable.
 */
export type SessionSignal =
  | { readonly type: "connected"; readonly error: string | null }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "authExpired"; readonly error: string }
  | { readonly type: "listenFatal"; readonly error: string }
  | { readonly type: "gaiaLoggedOut"; readonly error: string }
  | { readonly type: "unpaired"; readonly error: string };

const aad = (userId: string): DataBoxAad => ({
  userId,
  table: "gm_session",
  rowKey: userId,
  column: "auth_data",
});

const storageError = (operation: string, userId: string, cause: unknown) =>
  new RcsStorageError({
    operation,
    userId,
    cause,
    message:
      "openrcs could not read or update your phone session because the database did not respond. Your pairing is unchanged; try again in a moment.",
  });

const notPaired = (userId: string) =>
  new RcsNotPairedError({
    userId,
    message:
      "No phone is paired with this openrcs account. Open the openrcs dashboard and pair your phone's Google Messages first.",
  });

/** Next status after `signal`. Pure; exported for tests. */
const nextStatus = (current: GmSessionStatus, signal: SessionSignal): GmSessionStatus => {
  switch (signal.type) {
    case "connected":
      return current === "unpaired" ? "unpaired" : "paired";
    case "failed":
      return current;
    case "authExpired":
    case "listenFatal":
    case "gaiaLoggedOut":
      return current === "unpaired" ? "unpaired" : "needs_repair";
    case "unpaired":
      return "unpaired";
  }
};

const recordColumns = {
  userId: gmSession.userId,
  kind: gmSession.kind,
  status: gmSession.status,
  dekId: gmSession.dekId,
  phoneLabel: gmSession.phoneLabel,
  lastConnectedAt: gmSession.lastConnectedAt,
  lastError: gmSession.lastError,
} as const;

/** Session metadata without decrypting anything. `null` when there is no row. */
const readRecord = (
  db: Database,
  userId: string,
): Promise<Result<GmSessionRecord | null, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select(recordColumns)
        .from(gmSession)
        .where(eq(gmSession.userId, userId))
        .limit(1);
      return row ?? null;
    },
    catch: (cause) => storageError("sessionStore.readRecord", userId, cause),
  });

/**
 * Load and decrypt the session. Returns it whatever its status (callers that
 * need the phone check `status === "paired"`), except `unpaired`, which is
 * RcsNotPairedError.
 */
const load = async (
  db: Database,
  ctx: RcsContext,
): Promise<
  Result<
    LoadedSession,
    RcsNotPairedError | RcsKeyMismatchError | RcsSessionCorruptError | RcsStorageError
  >
> => {
  const read = await Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select({ ...recordColumns, authDataEnc: gmSession.authDataEnc })
        .from(gmSession)
        .where(eq(gmSession.userId, ctx.userId))
        .limit(1);
      return row ?? null;
    },
    catch: (cause) => storageError("sessionStore.load", ctx.userId, cause),
  });
  if (read.isErr()) return Result.err(read.error);
  const row = read.value;
  if (row === null || row.status === "unpaired") return Result.err(notPaired(ctx.userId));
  if (row.dekId !== ctx.dek.id) {
    return Result.err(
      new RcsKeyMismatchError({
        userId: ctx.userId,
        sessionDekId: row.dekId,
        clientDekId: ctx.dek.id,
        message:
          "Your stored phone session was sealed under a different key than your current one. Nothing was decrypted or changed. Pair your phone again from the openrcs dashboard to replace the session.",
      }),
    );
  }
  const corrupt = (reason: string) =>
    new RcsSessionCorruptError({
      userId: ctx.userId,
      reason,
      message:
        "Your stored phone session could not be opened. It has not been changed or deleted. Pair your phone again from the openrcs dashboard to replace it.",
    });
  const opened = DataBox.open(ctx.dek, row.authDataEnc, aad(ctx.userId));
  if (opened.isErr()) return Result.err(corrupt(opened.error._tag));
  const parsed = AuthData.parse(opened.value);
  if (parsed.isErr()) return Result.err(corrupt(parsed.error._tag));
  return Result.ok({
    userId: row.userId,
    kind: row.kind,
    status: row.status,
    dekId: row.dekId,
    phoneLabel: row.phoneLabel,
    lastConnectedAt: row.lastConnectedAt,
    lastError: row.lastError,
    authData: parsed.value,
  });
};

/** Create or replace the session right after pairing (status `paired`, dek_id = ctx.dek.id). */
const save = (
  db: Database,
  ctx: RcsContext,
  session: { kind: GmSessionKind; phoneLabel: string | null; authData: AuthData; now?: Date },
): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const authDataEnc = DataBox.seal(ctx.dek, AuthData.serialize(session.authData), aad(ctx.userId));
      const now = session.now ?? new Date();
      const values = {
        kind: session.kind,
        status: "paired" as const,
        dekId: ctx.dek.id,
        authDataEnc,
        phoneLabel: session.phoneLabel,
        lastConnectedAt: now,
        lastError: null,
      };
      await db
        .insert(gmSession)
        .values({ userId: ctx.userId, ...values })
        .onConflictDoUpdate({ target: gmSession.userId, set: values });
    },
    catch: (cause) => storageError("sessionStore.save", ctx.userId, cause),
  });

/**
 * Re-seal changed AuthData (refreshed token, rotated cookies). Only writes a
 * row sealed with the same DEK, so work started before a re-pairing under a
 * new key cannot overwrite the newer session.
 */
const saveAuthData = (
  db: Database,
  ctx: RcsContext,
  authData: AuthData,
): Promise<Result<void, RcsNotPairedError | RcsStorageError>> =>
  Result.tryPromise({
    try: () =>
      db
        .update(gmSession)
        .set({ authDataEnc: DataBox.seal(ctx.dek, AuthData.serialize(authData), aad(ctx.userId)) })
        .where(and(eq(gmSession.userId, ctx.userId), eq(gmSession.dekId, ctx.dek.id)))
        .returning({ userId: gmSession.userId }),
    catch: (cause) => storageError("sessionStore.saveAuthData", ctx.userId, cause),
  }).then((result) =>
    result.andThen((rows) =>
      rows.length === 1 ? Result.ok(undefined) : Result.err(notPaired(ctx.userId)),
    ),
  );

/** Apply a status transition and update last_connected_at / last_error. */
const record = async (
  db: Database,
  userId: string,
  signal: SessionSignal,
  now: Date = new Date(),
): Promise<Result<GmSessionStatus | null, RcsStorageError>> => {
  const current = await readRecord(db, userId);
  if (current.isErr()) return Result.err(current.error);
  if (current.value === null) return Result.ok(null);
  const status = nextStatus(current.value.status, signal);
  const lastError = signal.error;
  return Result.tryPromise({
    try: async () => {
      await db
        .update(gmSession)
        .set({
          status,
          lastError,
          ...(signal.type === "connected" ? { lastConnectedAt: now } : {}),
        })
        .where(eq(gmSession.userId, userId));
      return status;
    },
    catch: (cause) => storageError("sessionStore.record", userId, cause),
  });
};

const remove = (db: Database, userId: string): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.delete(gmSession).where(eq(gmSession.userId, userId));
    },
    catch: (cause) => storageError("sessionStore.delete", userId, cause),
  });

/** Short non-identifying label for the dashboard, derived from Google's opaque phone id. */
const phoneLabelFrom = (phoneId: string): string | null => {
  const trimmed = phoneId.trim();
  if (trimmed === "") return null;
  return `Android phone (${trimmed.slice(-6)})`;
};

export const SessionStore = {
  aad,
  nextStatus,
  readRecord,
  load,
  save,
  saveAuthData,
  record,
  delete: remove,
  phoneLabelFrom,
} as const;

import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { syncState } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { RcsStorageError } from "./errors";

/** Per-user sync bookkeeping (`sync_state`). No secrets or content. */
export type SyncState = {
  readonly lastSyncAt: Date | null;
  readonly lastSyncError: string | null;
};

const empty: SyncState = { lastSyncAt: null, lastSyncError: null };

const storageError = (operation: string, userId: string, cause: unknown) =>
  new RcsStorageError({
    operation,
    userId,
    cause,
    message:
      "openrcs could not read or record when your messages were last synced because the database did not respond. Stored messages are unchanged; try again in a moment.",
  });

const read = (db: Database, userId: string): Promise<Result<SyncState, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select({ lastSyncAt: syncState.lastSyncAt, lastSyncError: syncState.lastSyncError })
        .from(syncState)
        .where(eq(syncState.userId, userId))
        .limit(1);
      return row ?? empty;
    },
    catch: (cause) => storageError("syncState.read", userId, cause),
  });

const upsert = (
  db: Database,
  userId: string,
  values: { lastSyncAt?: Date; lastSyncError: string | null },
  operation: string,
): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db
        .insert(syncState)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: syncState.userId, set: values });
    },
    catch: (cause) => storageError(operation, userId, cause),
  });

export const SyncState = {
  empty,
  read,
  recordSuccess: (db: Database, userId: string, at: Date = new Date()) =>
    upsert(db, userId, { lastSyncAt: at, lastSyncError: null }, "syncState.recordSuccess"),
  /** Keeps `last_sync_at`, so staleness stays visible. `error` must be plain, content-free text. */
  recordFailure: (db: Database, userId: string, error: string) =>
    upsert(db, userId, { lastSyncError: error }, "syncState.recordFailure"),
} as const;

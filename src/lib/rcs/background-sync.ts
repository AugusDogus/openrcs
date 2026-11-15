import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { gmSession } from "@/lib/db/app-schema";
import { getDb, type Database } from "@/lib/db/client";
import { userKey } from "@/lib/db/vault-schema";
import { ServerKey, type Dek, type ServerKeyInvalidError, type VaultStorageError } from "@/lib/vault";
import type { RcsContext } from "./context";
import { describeForLog, RcsStorageError } from "./errors";
import { describePhoneError } from "./phone";
import { PhoneLease } from "./phone-lease";
import { SyncLimits, syncUser, type SyncError, type SyncOptions, type SyncSummary } from "./sync";
import { SyncState } from "./sync-state";

/**
 * Periodic incremental sync on the server, for every user whose phone is
 * paired (session `paired` and a server key). Started once per server
 * process (src/instrumentation.ts). Per user: skip if a sync finished
 * recently, take the phone lease or skip if it is busy, unlock with the
 * server key, run the incremental `syncUser` (which records the outcome in
 * `sync_state` and the session status). Failures are logged, never thrown.
 */

export const BACKGROUND_SYNC = {
  intervalMs: 60_000,
  /** A user synced more recently than this (by an agent, "Sync now" or the last tick) is skipped. */
  minGapMs: 30_000,
  /** Deadline of one user's sync. */
  budgetMs: 45_000,
  leaseTtlMs: 45_000,
} as const;

export type BackgroundSyncDeps = {
  readonly db: Database;
  readonly now: () => number;
  readonly unlock: (db: Database, userId: string) => Promise<Result<Dek | null, ServerKeyInvalidError | VaultStorageError>>;
  readonly sync: (db: Database, ctx: RcsContext, opts: SyncOptions) => Promise<Result<SyncSummary, SyncError>>;
};

export type BackgroundSyncOutcome =
  | { readonly kind: "synced"; readonly summary: SyncSummary }
  | { readonly kind: "skipped"; readonly reason: "recent" | "busy" | "no_key" }
  | { readonly kind: "failed"; readonly message: string };

const log = (level: "warn" | "error", text: string) => console[level](`[rcs:background-sync] ${text}`);

/** One user's turn. Never throws. */
const syncOne = async (deps: BackgroundSyncDeps, userId: string): Promise<BackgroundSyncOutcome> => {
  const state = await SyncState.read(deps.db, userId);
  if (state.isErr()) return { kind: "failed", message: state.error.message };
  const last = state.value.lastSyncAt;
  if (last !== null && deps.now() - last.getTime() < BACKGROUND_SYNC.minGapMs) return { kind: "skipped", reason: "recent" };

  const acquired = await PhoneLease.tryAcquire(deps.db, userId, { ttlMs: BACKGROUND_SYNC.leaseTtlMs, now: deps.now });
  if (acquired.isErr()) return { kind: "failed", message: acquired.error.message };
  const lease = acquired.value;
  if (lease === null) return { kind: "skipped", reason: "busy" };
  const stopKeepAlive = PhoneLease.keepAlive(deps.db, lease, {
    ttlMs: BACKGROUND_SYNC.leaseTtlMs,
    onLost: (error) => log("warn", `lease renewal failed: ${describeForLog(error)}`),
  });
  try {
    const key = await deps.unlock(deps.db, userId);
    if (key.isErr()) return { kind: "failed", message: key.error.message };
    if (key.value === null) return { kind: "skipped", reason: "no_key" };
    const synced = await deps.sync(deps.db, { userId, dek: key.value }, {
      ...SyncLimits.incremental,
      deadlineMs: deps.now() + BACKGROUND_SYNC.budgetMs,
      now: deps.now,
      phone: { lease: { held: lease } },
    });
    return synced.isOk()
      ? { kind: "synced", summary: synced.value }
      : { kind: "failed", message: describePhoneError(synced.error) };
  } catch (error: unknown) {
    log("error", `unexpected failure for user ${userId}: ${error instanceof Error ? error.name : "unknown"}`);
    return { kind: "failed", message: "The background sync failed unexpectedly." };
  } finally {
    stopKeepAlive();
    const released = await PhoneLease.release(deps.db, lease);
    if (released.isErr()) log("warn", `lease release failed: ${describeForLog(released.error)}`);
  }
};

/** Users with a paired session and a server key. */
const pairedUsers = (db: Database): Promise<Result<string[], RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const rows = await db
        .select({ userId: gmSession.userId })
        .from(gmSession)
        .innerJoin(userKey, eq(userKey.userId, gmSession.userId))
        .where(and(eq(gmSession.status, "paired"), eq(gmSession.dekId, userKey.dekId)));
      return rows.map((row) => row.userId);
    },
    catch: (cause) =>
      new RcsStorageError({
        operation: "backgroundSync.pairedUsers",
        userId: "*",
        cause,
        message: "The background sync could not list paired phones because the database did not respond.",
      }),
  });

/** One pass over every paired user, one at a time. Never throws. */
const tick = async (deps: BackgroundSyncDeps): Promise<ReadonlyMap<string, BackgroundSyncOutcome>> => {
  const outcomes = new Map<string, BackgroundSyncOutcome>();
  const users = await pairedUsers(deps.db);
  if (users.isErr()) {
    log("error", describeForLog(users.error));
    return outcomes;
  }
  for (const userId of users.value) {
    const outcome = await syncOne(deps, userId).catch(
      (): BackgroundSyncOutcome => ({ kind: "failed", message: "The background sync failed unexpectedly." }),
    );
    if (outcome.kind === "failed") log("warn", `sync for user ${userId} failed: ${outcome.message}`);
    outcomes.set(userId, outcome);
  }
  return outcomes;
};

declare global {
  // One scheduler per server process, even if instrumentation runs again (dev reloads).
  var __openrcsBackgroundSync: { readonly stop: () => void } | undefined;
}

/** Runs `tick` every `intervalMs`, skipping a tick while the previous one still runs. Idempotent. */
const start = (deps: () => BackgroundSyncDeps, intervalMs: number = BACKGROUND_SYNC.intervalMs): void => {
  if (globalThis.__openrcsBackgroundSync) return;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.resolve()
      .then(() => tick(deps()))
      .catch((error: unknown) => log("error", `tick failed: ${error instanceof Error ? error.message : "unknown"}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  globalThis.__openrcsBackgroundSync = {
    stop: () => {
      clearInterval(timer);
      globalThis.__openrcsBackgroundSync = undefined;
    },
  };
};

export const BackgroundSync = {
  syncOne,
  tick,
  pairedUsers,
  start,
  /** Starts the scheduler against the app database and the real phone. */
  startFromEnv: (): void =>
    start(() => ({ db: getDb(), now: Date.now, unlock: ServerKey.unlock, sync: syncUser })),
} as const;

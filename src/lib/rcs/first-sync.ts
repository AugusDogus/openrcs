import type { Database } from "@/lib/db/client";
import type { RcsContext } from "./context";
import { describeForLog } from "./errors";
import type { WithPhoneOptions } from "./phone";
import { PhoneLease } from "./phone-lease";
import { backfill, type SyncProgress } from "./sync";
import { SyncState } from "./sync-state";

/**
 * The first sync after pairing (a backfill), run on the server detached from
 * the pairing request: it keeps the phone lease the pairing took and reports
 * progress in server memory, which the dashboard polls (GET /api/sync/status).
 * Failures are recorded in `sync_state` like any sync's.
 */

export const FIRST_SYNC = {
  /** The backfill stops after this long; the rest syncs incrementally later. */
  budgetMs: 240_000,
  leaseTtlMs: 60_000,
} as const;

/** `total` is null until the phone has listed the conversations to sync. */
export type FirstSyncProgress = { readonly done: number; readonly total: number | null };

type Running = { progress: FirstSyncProgress; readonly abort: AbortController };

export type FirstSyncRegistry = Map<string, Running>;

declare global {
  // One per server process, shared by every route bundle.
  var __openrcsFirstSync: FirstSyncRegistry | undefined;
}

const sharedRegistry = (): FirstSyncRegistry => {
  globalThis.__openrcsFirstSync ??= new Map();
  return globalThis.__openrcsFirstSync;
};

export type FirstSyncOptions = {
  /** Tests pass their own registry and a scripted phone. */
  readonly registry?: FirstSyncRegistry;
  readonly phone?: Pick<WithPhoneOptions, "createClient" | "fetch">;
  readonly now?: () => number;
};

const UNEXPECTED =
  "The first sync after pairing stopped unexpectedly. Stored messages are kept; openrcs keeps syncing in the background.";

/**
 * Runs the backfill for `ctx` holding `lease`, which it renews and finally
 * releases. Returns when the backfill is over; the pairing does not wait.
 */
const run = async (
  db: Database,
  ctx: RcsContext,
  lease: PhoneLease,
  opts: FirstSyncOptions = {},
): Promise<void> => {
  const registry = opts.registry ?? sharedRegistry();
  const now = opts.now ?? Date.now;
  const entry: Running = { progress: { done: 0, total: null }, abort: new AbortController() };
  registry.set(ctx.userId, entry);
  const stopKeepAlive = PhoneLease.keepAlive(db, lease, {
    ttlMs: FIRST_SYNC.leaseTtlMs,
    onLost: (error) => console.warn(`[rcs:first-sync] lease renewal failed: ${describeForLog(error)}`),
  });
  try {
    const synced = await backfill(db, ctx, {
      deadlineMs: now() + FIRST_SYNC.budgetMs,
      signal: entry.abort.signal,
      now,
      onProgress: (progress: SyncProgress) => {
        entry.progress = { done: progress.conversationsDone, total: progress.conversationsTotal };
      },
      phone: { ...opts.phone, lease: { held: lease } },
    });
    if (synced.isErr()) console.warn(`[rcs:first-sync] stopped: ${describeForLog(synced.error)}`);
  } catch (error: unknown) {
    console.error(`[rcs:first-sync] unexpected failure for user ${ctx.userId}: ${error instanceof Error ? error.name : "unknown"}`);
    const recorded = await SyncState.recordFailure(db, ctx.userId, UNEXPECTED);
    if (recorded.isErr()) console.warn(`[rcs:first-sync] recording the failure failed: ${describeForLog(recorded.error)}`);
  } finally {
    stopKeepAlive();
    if (registry.get(ctx.userId) === entry) registry.delete(ctx.userId);
    const released = await PhoneLease.release(db, lease);
    if (released.isErr()) console.warn(`[rcs:first-sync] lease release failed: ${describeForLog(released.error)}`);
  }
};

export const FirstSync = {
  run,
  /** The running first sync's progress, or null when none is running for the user. */
  progress: (userId: string, registry: FirstSyncRegistry = sharedRegistry()): FirstSyncProgress | null =>
    registry.get(userId)?.progress ?? null,
  /** Stops a running first sync (unpair); what it stored stays until the caller deletes it. */
  cancel: (userId: string, registry: FirstSyncRegistry = sharedRegistry()): void => {
    registry.get(userId)?.abort.abort();
  },
} as const;

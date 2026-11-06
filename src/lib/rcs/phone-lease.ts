import { randomUUID } from "node:crypto";
import { Result } from "better-result";
import { and, eq, gte, lt } from "drizzle-orm";
import { phoneLease } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { RcsLeaseLostError, RcsPhoneBusyError, RcsStorageError } from "./errors";

/**
 * Per-user mutex in `phone_lease` so only one function invocation talks to
 * the phone at a time. Acquisition is one atomic upsert that only replaces an
 * expired row; every holder has a unique id, and only the holder can renew or
 * release. A crashed invocation's lease simply expires.
 */
export type PhoneLease = {
  readonly userId: string;
  readonly holder: string;
  /** Unix epoch ms. */
  readonly expiresAt: number;
};

export type AcquireOptions = {
  /** Lease lifetime; keep it short and renew during long work. Default 45 s. */
  readonly ttlMs?: number;
  /** How long to wait for another holder before giving up. Default 20 s. */
  readonly waitMs?: number;
  /** Poll interval while waiting. Default 250 ms, backing off to 1 s. */
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};

export const DEFAULT_LEASE_TTL_MS = 45_000;
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_POLL_MS = 250;
const MAX_POLL_MS = 1_000;

const storageError = (operation: string, userId: string, cause: unknown) =>
  new RcsStorageError({
    operation,
    userId,
    cause,
    message:
      "openrcs could not coordinate access to your phone because the database did not respond. Nothing was sent or changed; try again in a moment.",
  });

/** One atomic attempt: take the lease if it is free or expired. `null` when someone else holds it. */
const tryAcquire = (
  db: Database,
  userId: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<Result<PhoneLease | null, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const now = (opts.now ?? Date.now)();
      const holder = randomUUID();
      const expiresAt = now + (opts.ttlMs ?? DEFAULT_LEASE_TTL_MS);
      const rows = await db
        .insert(phoneLease)
        .values({ userId, holder, expiresAt })
        .onConflictDoUpdate({
          target: phoneLease.userId,
          set: { holder, expiresAt },
          setWhere: lt(phoneLease.expiresAt, now),
        })
        .returning({ holder: phoneLease.holder });
      return rows[0]?.holder === holder ? { userId, holder, expiresAt } : null;
    },
    catch: (cause) => storageError("phoneLease.tryAcquire", userId, cause),
  });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Take the lease, waiting (bounded) while another invocation holds it. */
const acquire = async (
  db: Database,
  userId: string,
  opts: AcquireOptions = {},
): Promise<Result<PhoneLease, RcsPhoneBusyError | RcsStorageError>> => {
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const started = now();
  let poll = opts.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    const attempt = await tryAcquire(db, userId, { ttlMs: opts.ttlMs, now });
    if (attempt.isErr()) return Result.err(attempt.error);
    if (attempt.value !== null) return Result.ok(attempt.value);
    const waited = now() - started;
    if (waited >= waitMs || opts.signal?.aborted) {
      return Result.err(
        new RcsPhoneBusyError({
          userId,
          waitedMs: waited,
          message:
            "Your phone is busy with another openrcs request (a sync, send or pairing). Nothing was changed; try again in a minute.",
        }),
      );
    }
    await sleep(Math.min(poll, Math.max(0, waitMs - waited)), opts.signal);
    poll = Math.min(MAX_POLL_MS, Math.round(poll * 1.5));
  }
};

/** Extend the lease; fails with RcsLeaseLostError if it expired and someone else took it. */
const renew = (
  db: Database,
  lease: PhoneLease,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<Result<PhoneLease, RcsLeaseLostError | RcsStorageError>> => {
  const expiresAt = (opts.now ?? Date.now)() + (opts.ttlMs ?? DEFAULT_LEASE_TTL_MS);
  return Result.tryPromise({
    try: () =>
      db
        .update(phoneLease)
        .set({ expiresAt })
        .where(and(eq(phoneLease.userId, lease.userId), eq(phoneLease.holder, lease.holder)))
        .returning({ holder: phoneLease.holder }),
    catch: (cause) => storageError("phoneLease.renew", lease.userId, cause),
  }).then((result) =>
    result.andThen((rows) =>
      rows.length === 1
        ? Result.ok({ ...lease, expiresAt })
        : Result.err(
            new RcsLeaseLostError({
              userId: lease.userId,
              message:
                "Another openrcs request took over your phone while this one was still running. Try again.",
            }),
          ),
    ),
  );
};

/** Release the lease if we still hold it. Releasing someone else's lease is a no-op. */
const release = (db: Database, lease: PhoneLease): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db
        .delete(phoneLease)
        .where(and(eq(phoneLease.userId, lease.userId), eq(phoneLease.holder, lease.holder)));
    },
    catch: (cause) => storageError("phoneLease.release", lease.userId, cause),
  });

/** Whether an unexpired lease exists for the user. */
const isHeld = (
  db: Database,
  userId: string,
  now: () => number = Date.now,
): Promise<Result<boolean, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const rows = await db
        .select({ holder: phoneLease.holder })
        .from(phoneLease)
        .where(and(eq(phoneLease.userId, userId), gte(phoneLease.expiresAt, now())))
        .limit(1);
      return rows.length > 0;
    },
    catch: (cause) => storageError("phoneLease.isHeld", userId, cause),
  });

/**
 * Renew the lease every `ttlMs / 3` until stopped, for operations that may
 * outlive one TTL (pairing, backfill). `onLost` runs once if renewal fails.
 */
const keepAlive = (
  db: Database,
  lease: PhoneLease,
  opts: { ttlMs?: number; onLost?: (error: RcsLeaseLostError | RcsStorageError) => void } = {},
): (() => void) => {
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  let stopped = false;
  const timer = setInterval(() => {
    void renew(db, lease, { ttlMs }).then((result) => {
      if (result.isErr() && !stopped) {
        stopped = true;
        clearInterval(timer);
        opts.onLost?.(result.error);
      }
    });
  }, Math.max(1_000, Math.floor(ttlMs / 3)));
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

export const PhoneLease = {
  tryAcquire,
  acquire,
  renew,
  release,
  isHeld,
  keepAlive,
} as const;

import { Result } from "better-result";
import { lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { requestThrottle } from "@/lib/db/vault-schema";
import { OAuthErrors, type OAuthStorageError } from "./errors";

export type ThrottleRule = { readonly limit: number; readonly windowMs: number };

export type ThrottleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Fixed-window counter in `request_throttle`, updated atomically with one
 * upsert so concurrent serverless instances share it. SQLite evaluates every
 * SET expression against the pre-update row, so both CASEs see the old window.
 */
const hit = async (
  db: Database,
  key: string,
  rule: ThrottleRule,
  now: number,
): Promise<Result<ThrottleDecision, OAuthStorageError>> => {
  const windowExpired = sql`${requestThrottle.windowStart} <= ${now - rule.windowMs}`;
  const counted = await Result.tryPromise({
    try: () =>
      db
        .insert(requestThrottle)
        .values({ key, windowStart: now, count: 1 })
        .onConflictDoUpdate({
          target: requestThrottle.key,
          set: {
            windowStart: sql`case when ${windowExpired} then ${now} else ${requestThrottle.windowStart} end`,
            count: sql`case when ${windowExpired} then 1 else ${requestThrottle.count} + 1 end`,
          },
        })
        .returning({ count: requestThrottle.count, windowStart: requestThrottle.windowStart }),
    catch: (cause) => OAuthErrors.storage(`throttle ${key.split(":")[0] ?? "request"}`, cause),
  });
  if (counted.isErr()) return Result.err(counted.error);
  const row = counted.value[0];
  if (!row || row.count <= rule.limit) return Result.ok({ allowed: true });
  return Result.ok({
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + rule.windowMs - now) / 1000)),
  });
};

/** All rules must allow; the longest wait wins. */
const hitAll = async (
  db: Database,
  checks: readonly { readonly key: string; readonly rule: ThrottleRule }[],
  now: number,
): Promise<Result<ThrottleDecision, OAuthStorageError>> => {
  let decision: ThrottleDecision = { allowed: true };
  for (const check of checks) {
    const result = await hit(db, check.key, check.rule, now);
    if (result.isErr()) return result;
    if (!result.value.allowed) {
      if (decision.allowed || result.value.retryAfterSeconds > decision.retryAfterSeconds) {
        decision = result.value;
      }
    }
  }
  return Result.ok(decision);
};

const rules = {
  registerPerIp: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** Bounds what open registration can store per hour, however many addresses an attacker has. */
  registerGlobal: { limit: 300, windowMs: 60 * 60 * 1000 },
  tokenPerIp: { limit: 120, windowMs: 60 * 1000 },
  /** Per client AND address (client ids are public). */
  tokenPerClient: { limit: 60, windowMs: 60 * 1000 },
} as const satisfies Record<string, ThrottleRule>;

const longestWindowMs = Math.max(...Object.values(rules).map((rule) => rule.windowMs));

/** Deletes counters whose window has ended under every rule. */
const prune = (db: Database, now: number): Promise<Result<void, OAuthStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.delete(requestThrottle).where(lte(requestThrottle.windowStart, now - longestWindowMs));
    },
    catch: (cause) => OAuthErrors.storage("prune expired throttle windows", cause),
  });

export const RequestThrottle = {
  hit,
  hitAll,
  prune,
  rules,
} as const;

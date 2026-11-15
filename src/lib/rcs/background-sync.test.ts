import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { phoneLease } from "@/lib/db/app-schema";
import { ServerKey } from "@/lib/vault/server-key";
import { BACKGROUND_SYNC, BackgroundSync, type BackgroundSyncDeps } from "./background-sync";
import { RcsPhoneError } from "./errors";
import { PhoneLease } from "./phone-lease";
import { SessionStore } from "./session-store";
import { syncUser, type SyncSummary } from "./sync";
import { SyncState } from "./sync-state";
import { RcsTesting, type RcsTestEnv } from "./testing";

let env: RcsTestEnv;
const clock = RcsTesting.clock();

beforeEach(async () => {
  env = await RcsTesting.setup();
  await RcsTesting.pair(env.db, env.ctx);
});
afterEach(async () => {
  await env.cleanup();
});

const summary: SyncSummary = {
  conversationsListed: 1,
  conversationsToSync: 0,
  conversationsSynced: 0,
  messagesStored: 0,
  truncatedConversations: 0,
  deadlineReached: false,
};

type SyncCall = { userId: string; dekId: string; leaseHeld: boolean; deadlineMs: number };

/** Deps around the test DB, with a recording fake sync. */
const deps = (sync?: BackgroundSyncDeps["sync"]) => {
  const calls: SyncCall[] = [];
  const value: BackgroundSyncDeps = {
    db: env.db,
    now: clock.now,
    unlock: (db, userId) => ServerKey.unlockWith(db, env.vault, userId),
    sync: async (db, ctx, opts) => {
      const [lease] = await db.select().from(phoneLease).where(eq(phoneLease.userId, ctx.userId));
      const held = opts.phone?.lease !== undefined && "held" in opts.phone.lease;
      calls.push({ userId: ctx.userId, dekId: ctx.dek.id, leaseHeld: held && lease !== undefined, deadlineMs: opts.deadlineMs });
      return sync ? sync(db, ctx, opts) : Result.ok(summary);
    },
  };
  return { deps: value, calls };
};

const leaseRows = async () => env.db.select().from(phoneLease);

describe("BackgroundSync.syncOne", () => {
  test("syncs a paired user with the server key while holding the lease, then releases it", async () => {
    const { deps: d, calls } = deps();
    const outcome = await BackgroundSync.syncOne(d, env.userId);
    expect(outcome).toEqual({ kind: "synced", summary });
    expect(calls).toEqual([
      { userId: env.userId, dekId: env.ctx.dek.id, leaseHeld: true, deadlineMs: clock.now() + BACKGROUND_SYNC.budgetMs },
    ]);
    expect(await leaseRows()).toHaveLength(0);
  });

  test("skips a user synced less than the minimum gap ago", async () => {
    (await SyncState.recordSuccess(env.db, env.userId, new Date(clock.now() - BACKGROUND_SYNC.minGapMs + 1))).unwrap();
    const { deps: d, calls } = deps();
    expect(await BackgroundSync.syncOne(d, env.userId)).toEqual({ kind: "skipped", reason: "recent" });
    clock.advance(1);
    expect((await BackgroundSync.syncOne(d, env.userId)).kind).toBe("synced");
    expect(calls).toHaveLength(1);
  });

  test("skips, without waiting, while another operation holds the phone", async () => {
    const held = (await PhoneLease.tryAcquire(env.db, env.userId, { now: clock.now })).unwrap();
    expect(held).not.toBeNull();
    const { deps: d, calls } = deps();
    expect(await BackgroundSync.syncOne(d, env.userId)).toEqual({ kind: "skipped", reason: "busy" });
    expect(calls).toHaveLength(0);
    expect(await leaseRows()).toHaveLength(1);
  });

  test("a failed or throwing sync is reported, and the lease is released", async () => {
    const failing = deps(async (_db, ctx) =>
      Result.err(
        new RcsPhoneError({ userId: ctx.userId, operation: "sync", gmTag: "GMPhoneNotRespondingError", needsRepair: false, message: "phone did not respond" }),
      ),
    );
    expect(await BackgroundSync.syncOne(failing.deps, env.userId)).toEqual({ kind: "failed", message: "phone did not respond" });
    expect(await leaseRows()).toHaveLength(0);

    const throwing = deps(async () => {
      throw new Error("boom");
    });
    expect((await BackgroundSync.syncOne(throwing.deps, env.userId)).kind).toBe("failed");
    expect(await leaseRows()).toHaveLength(0);
  });

  test("with the real incremental sync, stores messages and records the sync", async () => {
    const BASE = Date.UTC(2026, 10, 1);
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: BASE })],
      messages: new Map([["c1", [RcsTesting.message({ id: "m1", conversationId: "c1", timestampMs: BASE, text: "hi" })]]]),
    });
    const d: BackgroundSyncDeps = {
      db: env.db,
      now: Date.now,
      unlock: (db, userId) => ServerKey.unlockWith(db, env.vault, userId),
      sync: (db, ctx, opts) =>
        syncUser(db, ctx, { ...opts, phone: { ...opts.phone, createClient: RcsTesting.fakeClient(phone) } }),
    };
    const outcome = await BackgroundSync.syncOne(d, env.userId);
    expect(outcome.kind).toBe("synced");
    expect((await SyncState.read(env.db, env.userId)).unwrap().lastSyncAt).not.toBeNull();
    expect(phone.calls.connect).toBe(1);
    expect(await leaseRows()).toHaveLength(0);
  });
});

describe("BackgroundSync.tick", () => {
  test("visits paired users with a server key only, and keeps going after a failure", async () => {
    const repair = await RcsTesting.createUser(env.db);
    const repairCtx = { userId: repair, dek: (await ServerKey.createWith(env.db, env.vault, repair)).unwrap() };
    await RcsTesting.pair(env.db, repairCtx);
    (await SessionStore.record(env.db, repair, { type: "authExpired", error: "signed out" })).unwrap();

    const keyless = await RcsTesting.createUser(env.db);
    await RcsTesting.pair(env.db, { userId: keyless, dek: env.ctx.dek });

    const second = await RcsTesting.createUser(env.db);
    const secondCtx = { userId: second, dek: (await ServerKey.createWith(env.db, env.vault, second)).unwrap() };
    await RcsTesting.pair(env.db, secondCtx);

    expect(new Set((await BackgroundSync.pairedUsers(env.db)).unwrap())).toEqual(new Set([env.userId, second]));

    const { deps: d, calls } = deps(async (_db, ctx) => {
      if (ctx.userId === env.userId) throw new Error("boom");
      return Result.ok(summary);
    });
    const outcomes = await BackgroundSync.tick(d);
    expect(outcomes.get(env.userId)?.kind).toBe("failed");
    expect(outcomes.get(second)).toEqual({ kind: "synced", summary });
    expect(calls.map((call) => call.userId).sort()).toEqual([env.userId, second].sort());
  });
});

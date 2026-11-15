import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { GMClientOptions } from "@/lib/gm/client";
import { GMPhoneNotRespondingError } from "@/lib/gm/errors";
import { FirstSync, type FirstSyncRegistry } from "./first-sync";
import { PhoneLease } from "./phone-lease";
import { Store } from "./store";
import { SyncState } from "./sync-state";
import { RcsTesting, type RcsTestEnv } from "./testing";

let env: RcsTestEnv;
let registry: FirstSyncRegistry;

beforeEach(async () => {
  env = await RcsTesting.setup();
  await RcsTesting.pair(env.db, env.ctx);
  registry = new Map();
});
afterEach(async () => {
  await env.cleanup();
});

const BASE = Date.UTC(2026, 10, 1);

/** Two conversations; the first message fetch blocks until `release`. */
const gatedPhone = () => {
  const phone = RcsTesting.fakePhone({
    conversations: [
      RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: BASE + 1 }),
      RcsTesting.conversation({ id: "c2", name: "Bob", lastMessageMs: BASE }),
    ],
    messages: new Map([
      ["c1", [RcsTesting.message({ id: "m1", conversationId: "c1", timestampMs: BASE + 1, text: "hi" })]],
      ["c2", [RcsTesting.message({ id: "m2", conversationId: "c2", timestampMs: BASE, text: "yo" })]],
    ]),
  });
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const createClient = (options: GMClientOptions) => {
    const client = RcsTesting.fakeClient(phone)(options);
    return {
      ...client,
      fetchMessages: async (req: Parameters<typeof client.fetchMessages>[0]) => {
        entered.resolve();
        await gate.promise;
        return client.fetchMessages(req);
      },
    };
  };
  return { createClient, entered: entered.promise, release: () => gate.resolve() };
};

const takeLease = async () => {
  const lease = (await PhoneLease.tryAcquire(env.db, env.userId)).unwrap();
  if (lease === null) throw new Error("expected the lease");
  return lease;
};

describe("FirstSync", () => {
  test("runs on the server holding the pairing's lease, reports progress in memory, then releases", async () => {
    const phone = gatedPhone();
    const lease = await takeLease();
    const running = FirstSync.run(env.db, env.ctx, lease, { registry, phone: { createClient: phone.createClient } });

    expect(FirstSync.progress(env.userId, registry)).toEqual({ done: 0, total: null });
    await phone.entered;
    expect(FirstSync.progress(env.userId, registry)).toEqual({ done: 0, total: 2 });
    // Another operation cannot take the phone meanwhile.
    expect((await PhoneLease.tryAcquire(env.db, env.userId)).unwrap()).toBeNull();

    phone.release();
    await running;
    expect(FirstSync.progress(env.userId, registry)).toBeNull();
    expect((await Store.counts(env.db, env.userId)).unwrap()).toEqual({ conversations: 2, messages: 2 });
    expect((await SyncState.read(env.db, env.userId)).unwrap().lastSyncAt).not.toBeNull();
    expect((await PhoneLease.isHeld(env.db, env.userId)).unwrap()).toBe(false);
  });

  test("a failed first sync is recorded like any sync, and the lease is released", async () => {
    const offline = RcsTesting.fakeClient(RcsTesting.fakePhone());
    await FirstSync.run(env.db, env.ctx, await takeLease(), {
      registry,
      phone: {
        createClient: (opts) => ({
          ...offline(opts),
          listConversations: async () =>
            Result.err(new GMPhoneNotRespondingError({ action: "LIST_CONVERSATIONS", waitedMs: 30_000, message: "no answer" })),
        }),
      },
    });
    expect(FirstSync.progress(env.userId, registry)).toBeNull();
    expect((await SyncState.read(env.db, env.userId)).unwrap().lastSyncError).toContain("did not respond");
    expect((await PhoneLease.isHeld(env.db, env.userId)).unwrap()).toBe(false);
  });

  test("cancel stops it before the next conversation", async () => {
    const phone = gatedPhone();
    const running = FirstSync.run(env.db, env.ctx, await takeLease(), {
      registry,
      phone: { createClient: phone.createClient },
    });
    await phone.entered;
    FirstSync.cancel(env.userId, registry);
    phone.release();
    await running;
    expect((await Store.counts(env.db, env.userId)).unwrap().messages).toBe(1);
    expect(FirstSync.progress(env.userId, registry)).toBeNull();
    expect((await PhoneLease.isHeld(env.db, env.userId)).unwrap()).toBe(false);
  });
});

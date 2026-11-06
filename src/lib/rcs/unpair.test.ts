import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { gmSession, syncState } from "@/lib/db/app-schema";
import type { GMClientOptions } from "@/lib/gm/client";
import { VaultTesting } from "@/lib/vault/testing";
import { PhoneLease } from "./phone-lease";
import { Store } from "./store";
import { syncUser } from "./sync";
import { RcsTesting, type RcsTestEnv } from "./testing";
import { unpairUser } from "./unpair";

let env: RcsTestEnv;
const vault = VaultTesting.vaultConfig();

beforeEach(async () => {
  env = await RcsTesting.setup();
  await RcsTesting.pair(env.db, env.ctx);
});
afterEach(async () => {
  await env.cleanup();
});

const BASE = Date.UTC(2026, 10, 1);

/** A phone whose first message fetch blocks until `release` is called. */
const gatedPhone = () => {
  const phone = RcsTesting.fakePhone({
    conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: BASE })],
    messages: new Map([["c1", [RcsTesting.message({ id: "m1", conversationId: "c1", timestampMs: BASE, text: "hi" })]]]),
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

const rowsLeft = async () => ({
  ...(await Store.counts(env.db, env.userId)).unwrap(),
  syncState: (await env.db.select().from(syncState).where(eq(syncState.userId, env.userId))).length,
  session: (await env.db.select().from(gmSession).where(eq(gmSession.userId, env.userId))).length,
});

describe("unpairUser", () => {
  test("waits for an in-flight sync, so nothing it stores survives the unpair", async () => {
    const phone = gatedPhone();
    const sync = syncUser(env.db, env.ctx, {
      conversationCount: 10,
      messagesPerPage: 5,
      maxPagesPerConversation: 1,
      deadlineMs: Date.now() + 60_000,
      phone: { createClient: phone.createClient },
    });
    await phone.entered;

    let unpairDone = false;
    const unpair = unpairUser(env.db, {
      userId: env.userId,
      cookieHeader: null,
      vault,
      lease: { waitMs: 10_000, pollMs: 20 },
    }).then((result) => {
      unpairDone = true;
      return result;
    });
    await Bun.sleep(200);
    expect(unpairDone).toBe(false);

    phone.release();
    expect((await sync).isOk()).toBe(true);
    expect((await unpair).isOk()).toBe(true);
    expect(await rowsLeft()).toEqual({ conversations: 0, messages: 0, syncState: 0, session: 0 });
  });

  test("refuses, deleting nothing, while the phone stays busy past the wait", async () => {
    const held = (await PhoneLease.tryAcquire(env.db, env.userId)).unwrap();
    expect(held).not.toBeNull();
    const result = await unpairUser(env.db, {
      userId: env.userId,
      cookieHeader: null,
      vault,
      lease: { waitMs: 100, pollMs: 20 },
    });
    expect(result.isErr() && result.error._tag).toBe("RcsPhoneBusyError");
    expect((await rowsLeft()).session).toBe(1);
  });

  test("a sync that starts after the unpair records nothing", async () => {
    expect((await unpairUser(env.db, { userId: env.userId, cookieHeader: null, vault })).isOk()).toBe(true);
    const result = await syncUser(env.db, env.ctx, {
      conversationCount: 10,
      messagesPerPage: 5,
      maxPagesPerConversation: 1,
      deadlineMs: Date.now() + 60_000,
      phone: { createClient: gatedPhone().createClient },
    });
    expect(result.isErr() && result.error._tag).toBe("RcsNotPairedError");
    expect(await rowsLeft()).toEqual({ conversations: 0, messages: 0, syncState: 0, session: 0 });
  });
});

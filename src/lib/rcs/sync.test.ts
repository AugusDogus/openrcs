import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { gmSession } from "@/lib/db/app-schema";
import { GMAuthExpiredError, GMHttpError, GMPhoneNotRespondingError } from "@/lib/gm/errors";
import { SessionStore } from "./session-store";
import { Store } from "./store";
import { ensureFresh, syncConversation, syncUser, type SyncOptions } from "./sync";
import { SyncState } from "./sync-state";
import { RcsTesting, type FakePhone, type RcsTestEnv } from "./testing";

let env: RcsTestEnv;

beforeEach(async () => {
  env = await RcsTesting.setup();
  await RcsTesting.pair(env.db, env.ctx);
});

afterEach(async () => {
  await env.cleanup();
});

const BASE = Date.UTC(2026, 10, 1);

/** `count` messages at BASE + offset + i minutes, ids `${prefix}${i}`. */
const messages = (conversationId: string, prefix: string, count: number, offsetMin = 0) =>
  Array.from({ length: count }, (_, i) =>
    RcsTesting.message({
      id: `${prefix}${i}`,
      conversationId,
      timestampMs: BASE + (offsetMin + i) * 60_000,
      text: `${prefix} message ${i}`,
    }),
  );

const lastTs = (count: number, offsetMin = 0) => BASE + (offsetMin + count - 1) * 60_000;

const options = (phone: FakePhone, overrides: Partial<SyncOptions> = {}): SyncOptions => ({
  conversationCount: 10,
  messagesPerPage: 5,
  maxPagesPerConversation: 3,
  deadlineMs: Date.now() + 60_000,
  phone: { createClient: RcsTesting.fakeClient(phone) },
  ...overrides,
});

const fetchesFor = (phone: FakePhone, conversationId: string) =>
  phone.calls.fetchMessages.filter((call) => call.conversationId === conversationId).length;

const syncedTs = async (conversationId: string) =>
  (await Store.syncedTimestamps(env.db, env.userId, [conversationId])).unwrap().get(conversationId);

describe("syncUser", () => {
  test("first sync pages back to the page cap and records the boundary", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(12) })],
      messages: new Map([["c1", messages("c1", "a", 12)]]),
    });
    const summary = (await syncUser(env.db, env.ctx, options(phone))).unwrap();
    expect(summary).toMatchObject({
      conversationsListed: 1,
      conversationsToSync: 1,
      conversationsSynced: 1,
      messagesStored: 12,
      truncatedConversations: 0,
      deadlineReached: false,
    });
    expect(fetchesFor(phone, "c1")).toBe(3);
    expect(await syncedTs("c1")).toBe(lastTs(12));
    expect((await Store.counts(env.db, env.userId)).unwrap()).toEqual({ conversations: 1, messages: 12 });
    expect(phone.calls.close).toBe(1);
    expect((await SyncState.read(env.db, env.userId)).unwrap().lastSyncAt).not.toBeNull();
  });

  test("history longer than the page cap is truncated and reported", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(30) })],
      messages: new Map([["c1", messages("c1", "a", 30)]]),
    });
    const summary = (await syncUser(env.db, env.ctx, options(phone))).unwrap();
    expect(summary.messagesStored).toBe(15);
    expect(summary.truncatedConversations).toBe(1);
    expect(await syncedTs("c1")).toBe(lastTs(30));
  });

  test("incremental sync stops paging at synced_message_ts and skips unchanged conversations", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [
        RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(8) }),
        RcsTesting.conversation({ id: "c2", name: "Bob", lastMessageMs: lastTs(3) }),
      ],
      messages: new Map([
        ["c1", messages("c1", "a", 8)],
        ["c2", messages("c2", "b", 3)],
      ]),
    });
    await syncUser(env.db, env.ctx, options(phone));
    phone.calls.fetchMessages.length = 0;

    // Two new messages in c1 only.
    phone.messages.set("c1", [...messages("c1", "a", 8), ...messages("c1", "new", 2, 100)]);
    phone.conversations[0] = RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(2, 100) });

    const summary = (await syncUser(env.db, env.ctx, options(phone))).unwrap();
    expect(summary.conversationsToSync).toBe(1);
    expect(fetchesFor(phone, "c2")).toBe(0);
    // The newest page (5 messages) already reaches the stored boundary: one request.
    expect(fetchesFor(phone, "c1")).toBe(1);
    expect(await syncedTs("c1")).toBe(lastTs(2, 100));
    expect((await Store.counts(env.db, env.userId)).unwrap().messages).toBe(13);
  });

  test("respects the deadline: no RPC starts after it and unsynced conversations stay pending", async () => {
    const clock = RcsTesting.clock();
    const phone = RcsTesting.fakePhone({
      conversations: ["c1", "c2", "c3"].map((id, i) =>
        RcsTesting.conversation({ id, name: id, lastMessageMs: lastTs(4, i * 10) }),
      ),
      messages: new Map(["c1", "c2", "c3"].map((id, i) => [id, messages(id, id, 4, i * 10)])),
      // Every RPC takes 10 s of fake time.
      beforeRpc: () => clock.advance(10_000),
    });
    const summary = (
      await syncUser(
        env.db,
        env.ctx,
        options(phone, { deadlineMs: clock.now() + 25_000, now: clock.now }),
      )
    ).unwrap();
    // listConversations (10 s) + one fetch (20 s) fit; the next fetch would start at 20 s < 25 s, then stop.
    expect(summary.deadlineReached).toBe(true);
    expect(phone.calls.listConversations).toHaveLength(1);
    expect(phone.calls.fetchMessages).toHaveLength(2);
    expect(summary.conversationsSynced).toBe(2);
    expect(await syncedTs("c1")).toBe(null);
    expect(await syncedTs("c3")).not.toBe(null);
  });

  test("stores events that arrived on the long poll", async () => {
    const event = RcsTesting.message({ id: "evt-1", conversationId: "c9", timestampMs: BASE, text: "pushed" });
    const phone = RcsTesting.fakePhone({ connectEvents: [{ type: "message", message: event, isOld: false }] });
    await syncUser(env.db, env.ctx, options(phone));
    const page = (await Store.getMessages(env.db, env.ctx, "c9", { limit: 5 })).unwrap();
    expect(page.messages.map((m) => m.body)).toEqual(["pushed"]);
  });

  test("persists AuthData when the client reports it changed", async () => {
    const [before] = await env.db.select().from(gmSession).where(eq(gmSession.userId, env.userId));
    const phone = RcsTesting.fakePhone({ connectEvents: [{ type: "authDataChanged" }] });
    await syncUser(env.db, env.ctx, options(phone));
    const [after] = await env.db.select().from(gmSession).where(eq(gmSession.userId, env.userId));
    expect(after?.authDataEnc).not.toBe(before?.authDataEnc);
    expect((await SessionStore.load(env.db, env.ctx)).isOk()).toBe(true);
  });

  test("listenFatal marks the session as needing re-pair", async () => {
    const phone = RcsTesting.fakePhone({
      connectEvents: [
        {
          type: "listenFatal",
          error: new GMHttpError({ status: 401, action: "polling", message: "401 on long poll" }),
        },
      ],
    });
    await syncUser(env.db, env.ctx, options(phone));
    expect((await SessionStore.readRecord(env.db, env.userId)).unwrap()?.status).toBe("needs_repair");
  });

  test("a rejected session fails the sync, records needs_repair, and blocks the next attempt", async () => {
    const phone = RcsTesting.fakePhone({
      connectError: new GMAuthExpiredError({ reason: "pollingRejected", status: 401, message: "rejected" }),
    });
    const result = await syncUser(env.db, env.ctx, options(phone));
    expect(result.isErr() && result.error._tag).toBe("RcsPhoneError");
    expect((await SessionStore.readRecord(env.db, env.userId)).unwrap()?.status).toBe("needs_repair");
    const state = (await SyncState.read(env.db, env.userId)).unwrap();
    expect(state.lastSyncAt).toBeNull();
    expect(state.lastSyncError).toContain("Pair again");

    const again = await syncUser(env.db, env.ctx, options(phone));
    expect(again.isErr() && again.error._tag).toBe("RcsNeedsRepairError");
    expect(phone.calls.connect).toBe(1);
  });

  test("releases the lease even when the phone fails", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(1) })],
    });
    const offline = RcsTesting.fakeClient(phone);
    const result = await syncUser(env.db, env.ctx, {
      ...options(phone),
      phone: {
        createClient: (opts) => ({
          ...offline(opts),
          listConversations: async () =>
            Result.err(
              new GMPhoneNotRespondingError({ action: "LIST_CONVERSATIONS", waitedMs: 30_000, message: "no answer" }),
            ),
        }),
      },
    });
    expect(result.isErr() && result.error._tag).toBe("RcsPhoneError");
    const second = await syncUser(env.db, env.ctx, options(phone));
    expect(second.isOk()).toBe(true);
    expect((await SessionStore.readRecord(env.db, env.userId)).unwrap()?.status).toBe("paired");
  });
});

describe("syncConversation", () => {
  test("fetches an unknown conversation's metadata and its newest messages", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: lastTs(3) })],
      messages: new Map([["c1", messages("c1", "a", 3)]]),
    });
    const result = (
      await syncConversation(env.db, env.ctx, "c1", {
        messagesPerPage: 5,
        maxPagesPerConversation: 2,
        deadlineMs: Date.now() + 10_000,
        phone: { createClient: RcsTesting.fakeClient(phone) },
      })
    ).unwrap();
    expect(result).toEqual({ messagesStored: 3, outcome: "complete" });
    expect((await Store.getConversation(env.db, env.ctx, "c1")).unwrap()?.name).toBe("Alice");
    expect(await syncedTs("c1")).toBe(lastTs(3));
  });
});

describe("ensureFresh", () => {
  test("skips the phone when the last sync is recent", async () => {
    await SyncState.recordSuccess(env.db, env.userId, new Date());
    const phone = RcsTesting.fakePhone();
    const fresh = (
      await ensureFresh(env.db, env.ctx, {
        maxAgeMs: 60_000,
        deadlineMs: Date.now() + 10_000,
        phone: { createClient: RcsTesting.fakeClient(phone) },
      })
    ).unwrap();
    expect(fresh.status).toBe("fresh");
    expect(phone.calls.connect).toBe(0);
  });

  test("syncs when stale, and reports staleness instead of failing when the phone is unreachable", async () => {
    await SyncState.recordSuccess(env.db, env.userId, new Date(Date.now() - 120_000));
    const ok = RcsTesting.fakePhone();
    const synced = (
      await ensureFresh(env.db, env.ctx, {
        maxAgeMs: 60_000,
        deadlineMs: Date.now() + 10_000,
        phone: { createClient: RcsTesting.fakeClient(ok) },
      })
    ).unwrap();
    expect(synced.status).toBe("synced");

    await SyncState.recordSuccess(env.db, env.userId, new Date(Date.now() - 120_000));
    const down = RcsTesting.fakePhone({
      connectError: new GMHttpError({ status: 503, action: "polling", message: "unavailable" }),
    });
    const stale = (
      await ensureFresh(env.db, env.ctx, {
        maxAgeMs: 60_000,
        deadlineMs: Date.now() + 10_000,
        phone: { createClient: RcsTesting.fakeClient(down) },
      })
    ).unwrap();
    expect(stale.status).toBe("stale");
    if (stale.status === "stale") {
      expect(stale.needsRepair).toBe(false);
      expect(stale.reason).toContain("HTTP 503");
      expect(stale.lastSyncAt).not.toBeNull();
    }
  });
});

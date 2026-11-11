import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversation as conversationTable, message as messageTable } from "@/lib/db/app-schema";
import type { PlainConversation, PlainMessage } from "@/lib/gm/message";
import { Dek } from "@/lib/vault/dek";
import { Store } from "./store";
import { RcsTesting, type RcsTestEnv } from "./testing";

const plainConversation = (overrides: Partial<PlainConversation> = {}): PlainConversation => ({
  conversationId: "conv-1",
  name: "Zoë Café",
  isGroup: false,
  participants: [
    { participantId: "p-me", name: "Me", number: "+15550000000", isMe: true },
    { participantId: "p-zoe", name: "Zoë Café", number: "+1 (555) 123-4567", isMe: false },
  ],
  lastMessageTimestampMs: 1_000,
  lastMessagePreview: "see you at the crème brûlée place",
  unread: true,
  readOnly: false,
  status: "ACTIVE",
  ...overrides,
});

const plainMessage = (overrides: Partial<PlainMessage> = {}): PlainMessage => ({
  messageId: "msg-1",
  conversationId: "conv-1",
  timestampMs: 1_000,
  fromMe: false,
  senderName: "Zoë Café",
  senderNumber: "+1 (555) 123-4567",
  body: "Secret plans for Saturday",
  status: "INCOMING_COMPLETE",
  media: null,
  replyToId: null,
  reactions: [{ emoji: "👍", count: 1, participantIds: ["p-me"] }],
  tmpId: null,
  ...overrides,
});

let env: RcsTestEnv;

beforeEach(async () => {
  env = await RcsTesting.setup();
});

afterEach(async () => {
  await env.cleanup();
});

describe("encrypted storage", () => {
  test("round-trips conversations and messages", async () => {
    const { db, ctx } = env;
    expect((await Store.upsertConversations(db, ctx, [plainConversation()])).isOk()).toBe(true);
    expect((await Store.upsertMessages(db, ctx, [plainMessage()])).isOk()).toBe(true);

    const listed = (await Store.listConversations(db, ctx, { limit: 10 })).unwrap();
    expect(listed.unreadable).toBe(0);
    expect(listed.conversations).toHaveLength(1);
    expect(listed.conversations[0]).toMatchObject({
      conversationId: "conv-1",
      name: "Zoë Café",
      lastMessagePreview: "see you at the crème brûlée place",
      unread: true,
      syncedMessageTs: null,
    });

    const page = (await Store.getMessages(db, ctx, "conv-1", { limit: 10 })).unwrap();
    expect(page.messages).toEqual([{ ...plainMessage() }]);
  });

  test("the database holds no plaintext content", async () => {
    const { db, ctx } = env;
    await Store.upsertConversations(db, ctx, [plainConversation()]);
    await Store.upsertMessages(db, ctx, [plainMessage()]);

    const conversationRows = JSON.stringify((await db.$client.execute("select * from conversation")).rows);
    const messageRows = JSON.stringify((await db.$client.execute("select * from message")).rows);
    expect(conversationRows).toContain("conv-1");
    // Phone numbers with their punctuation: bare digits such as "555" also occur in updated_at.
    for (const secret of ["Secret plans", "Zoë", "Zo\\u00eb", "Café", "(555)", "+1555", "123-4567", "crème", "👍", "Saturday"]) {
      expect(conversationRows).not.toContain(secret);
      expect(messageRows).not.toContain(secret);
    }
    // Metadata stays queryable in plaintext.
    expect(messageRows).toContain("conv-1");
    expect(messageRows).toContain("INCOMING_COMPLETE");
  });

  test("a row moved to another user cannot be opened, even with the same key", async () => {
    const { db, ctx } = env;
    const otherUser = await RcsTesting.createUser(db);
    await Store.upsertMessages(db, ctx, [plainMessage()]);
    const [row] = await db.select().from(messageTable).where(eq(messageTable.userId, ctx.userId));
    if (row === undefined) throw new Error("expected the stored row");
    // Copy user A's ciphertext into user B's table rows verbatim.
    await db.insert(messageTable).values({ ...row, id: undefined, userId: otherUser });

    const otherWithSameKey = { userId: otherUser, dek: ctx.dek };
    const page = (await Store.getMessages(db, otherWithSameKey, "conv-1", { limit: 10 })).unwrap();
    expect(page.messages).toHaveLength(0);
    expect(page.unreadable).toBe(1);

    // And a different key cannot open the owner's row either.
    const wrongKey = { userId: ctx.userId, dek: Dek.generate() };
    const owner = (await Store.getMessages(db, wrongKey, "conv-1", { limit: 10 })).unwrap();
    expect(owner.messages).toHaveLength(0);
    expect(owner.unreadable).toBe(1);
  });

  test("a ciphertext swapped between rows of the same user does not open", async () => {
    const { db, ctx } = env;
    await Store.upsertMessages(db, ctx, [
      plainMessage({ messageId: "a", body: "first" }),
      plainMessage({ messageId: "b", body: "second", timestampMs: 2_000 }),
    ]);
    const [a] = await db.select().from(messageTable).where(eq(messageTable.messageId, "a"));
    if (a === undefined) throw new Error("expected row a");
    await db.update(messageTable).set({ contentEnc: a.contentEnc }).where(eq(messageTable.messageId, "b"));
    const page = (await Store.getMessages(db, ctx, "conv-1", { limit: 10 })).unwrap();
    expect(page.messages.map((m) => m.body)).toEqual(["first"]);
    expect(page.unreadable).toBe(1);
  });

  test("the phone's echo replaces the optimistic row stored under its temp id", async () => {
    const { db, ctx } = env;
    await Store.upsertMessages(db, ctx, [
      plainMessage({ messageId: "tmp_123456789012", tmpId: "tmp_123456789012", fromMe: true, status: "OUTGOING_SENDING" }),
    ]);
    await Store.upsertMessages(db, ctx, [
      plainMessage({ messageId: "real-1", tmpId: "tmp_123456789012", fromMe: true, status: "OUTGOING_DELIVERED" }),
    ]);
    const page = (await Store.getMessages(db, ctx, "conv-1", { limit: 10 })).unwrap();
    expect(page.messages.map((m) => [m.messageId, m.status])).toEqual([["real-1", "OUTGOING_DELIVERED"]]);
  });

  test("getMessages pages back with beforeMs and returns chat order", async () => {
    const { db, ctx } = env;
    await Store.upsertMessages(
      db,
      ctx,
      [1, 2, 3, 4, 5].map((n) => plainMessage({ messageId: `m${n}`, timestampMs: n * 1_000, body: `n${n}` })),
    );
    const newest = (await Store.getMessages(db, ctx, "conv-1", { limit: 2 })).unwrap();
    expect(newest.messages.map((m) => m.body)).toEqual(["n4", "n5"]);
    const older = (await Store.getMessages(db, ctx, "conv-1", { limit: 2, beforeMs: 4_000 })).unwrap();
    expect(older.messages.map((m) => m.body)).toEqual(["n2", "n3"]);
  });

  test("listConversations filters by name and participant number", async () => {
    const { db, ctx } = env;
    await Store.upsertConversations(db, ctx, [
      plainConversation(),
      plainConversation({
        conversationId: "conv-2",
        name: "Bob",
        lastMessageTimestampMs: 2_000,
        participants: [{ participantId: "p-bob", name: "Bob", number: "+44 20 7946 0000", isMe: false }],
      }),
    ]);
    const byAccentlessName = (await Store.listConversations(db, ctx, { limit: 10, query: "zoe cafe" })).unwrap();
    expect(byAccentlessName.conversations.map((c) => c.conversationId)).toEqual(["conv-1"]);
    const byDigits = (await Store.listConversations(db, ctx, { limit: 10, query: "2079460000" })).unwrap();
    expect(byDigits.conversations.map((c) => c.conversationId)).toEqual(["conv-2"]);
    const all = (await Store.listConversations(db, ctx, { limit: 10 })).unwrap();
    expect(all.conversations.map((c) => c.conversationId)).toEqual(["conv-2", "conv-1"]);
  });

  test("deleteUserData removes only that user's rows", async () => {
    const { db, ctx } = env;
    const other = { userId: await RcsTesting.createUser(db), dek: Dek.generate() };
    for (const c of [ctx, other]) {
      await Store.upsertConversations(db, c, [plainConversation()]);
      await Store.upsertMessages(db, c, [plainMessage()]);
    }
    expect((await Store.deleteUserData(db, ctx.userId)).isOk()).toBe(true);
    expect((await Store.counts(db, ctx.userId)).unwrap()).toEqual({ conversations: 0, messages: 0 });
    expect((await Store.counts(db, other.userId)).unwrap()).toEqual({ conversations: 1, messages: 1 });
    const remaining = await db.select().from(conversationTable);
    expect(remaining.map((r) => r.userId)).toEqual([other.userId]);
  });
});

describe("searchMessages", () => {
  const seed = async () => {
    const { db, ctx } = env;
    const zoe = { senderName: "Zoë", senderNumber: "+15551234567" };
    await Store.upsertConversations(db, ctx, [
      plainConversation({ name: "Zoë" }),
      plainConversation({ conversationId: "conv-2", name: "Book Club", isGroup: true, participants: [] }),
    ]);
    await Store.upsertMessages(db, ctx, [
      plainMessage({ ...zoe, messageId: "m1", timestampMs: Date.UTC(2026, 9, 1), body: "Dinner at the CAFÉ tonight?" }),
      plainMessage({ ...zoe, messageId: "m2", timestampMs: Date.UTC(2026, 9, 2), body: "the red fox jumps" }),
      plainMessage({ ...zoe, messageId: "m3", timestampMs: Date.UTC(2026, 9, 3), body: "red and quick fox" }),
      plainMessage({
        messageId: "m4",
        conversationId: "conv-2",
        timestampMs: Date.UTC(2026, 9, 4),
        body: "chapter seven",
        senderName: "Ana",
        senderNumber: "+15559876543",
      }),
    ]);
  };

  const ids = (hits: readonly { messageId: string }[]) => hits.map((h) => h.messageId);

  test("matches case- and diacritic-insensitively", async () => {
    await seed();
    const result = (await Store.searchMessages(env.db, env.ctx, { query: "cafe", limit: 10 })).unwrap();
    expect(ids(result.hits)).toEqual(["m1"]);
    const reverse = (await Store.searchMessages(env.db, env.ctx, { query: "CAFÉ dinner", limit: 10 })).unwrap();
    expect(ids(reverse.hits)).toEqual(["m1"]);
  });

  test("requires every term, supports quoted phrases, newest first", async () => {
    await seed();
    const both = (await Store.searchMessages(env.db, env.ctx, { query: "fox red", limit: 10 })).unwrap();
    expect(ids(both.hits)).toEqual(["m3", "m2"]);
    const phrase = (await Store.searchMessages(env.db, env.ctx, { query: '"red fox"', limit: 10 })).unwrap();
    expect(ids(phrase.hits)).toEqual(["m2"]);
    const none = (await Store.searchMessages(env.db, env.ctx, { query: "fox unicorn", limit: 10 })).unwrap();
    expect(none.hits).toHaveLength(0);
  });

  test("matches sender name, sender number digits and conversation name", async () => {
    await seed();
    const bySender = (await Store.searchMessages(env.db, env.ctx, { query: "ana seven", limit: 10 })).unwrap();
    expect(ids(bySender.hits)).toEqual(["m4"]);
    const byNumber = (await Store.searchMessages(env.db, env.ctx, { query: "555-987", limit: 10 })).unwrap();
    expect(ids(byNumber.hits)).toEqual(["m4"]);
    const byConversation = (await Store.searchMessages(env.db, env.ctx, { query: "book club", limit: 10 })).unwrap();
    expect(ids(byConversation.hits)).toEqual(["m4"]);
    expect(byConversation.hits[0]?.conversationName).toBe("Book Club");
  });

  test("applies conversation and time filters in SQL", async () => {
    await seed();
    const inConversation = (
      await Store.searchMessages(env.db, env.ctx, { query: "e", conversationId: "conv-2", limit: 10 })
    ).unwrap();
    expect(ids(inConversation.hits)).toEqual(["m4"]);
    expect(inConversation.totalCandidates).toBe(1);

    const windowed = (
      await Store.searchMessages(env.db, env.ctx, {
        query: "e",
        sinceMs: Date.UTC(2026, 9, 2),
        untilMs: Date.UTC(2026, 9, 4),
        limit: 10,
      })
    ).unwrap();
    expect(ids(windowed.hits)).toEqual(["m3", "m2"]);
    expect(windowed.totalCandidates).toBe(2);
  });

  test("reports scan stats and the cap, paging in batches", async () => {
    const { db, ctx } = env;
    await Store.upsertMessages(
      db,
      ctx,
      Array.from({ length: 10 }, (_, i) =>
        plainMessage({ messageId: `bulk-${i}`, timestampMs: 10_000 + i, body: i === 0 ? "needle" : "hay" }),
      ),
    );
    const capped = (
      await Store.searchMessages(db, ctx, { query: "needle", limit: 5, scanCap: 5, batchSize: 2 })
    ).unwrap();
    expect(capped.hits).toHaveLength(0);
    expect(capped.scannedCount).toBe(5);
    expect(capped.totalCandidates).toBe(10);
    expect(capped.capped).toBe(true);

    const full = (
      await Store.searchMessages(db, ctx, { query: "needle", limit: 5, scanCap: 100, batchSize: 3 })
    ).unwrap();
    expect(ids(full.hits)).toEqual(["bulk-0"]);
    expect(full.scannedCount).toBe(10);
    expect(full.capped).toBe(false);
    expect(full.limitReached).toBe(false);

    const limited = (await Store.searchMessages(db, ctx, { query: "hay", limit: 2, batchSize: 4 })).unwrap();
    expect(ids(limited.hits)).toEqual(["bulk-9", "bulk-8"]);
    expect(limited.limitReached).toBe(true);
    expect(limited.capped).toBe(false);
  });

  test("rejects an empty query", async () => {
    const result = await Store.searchMessages(env.db, env.ctx, { query: '  "" ', limit: 10 });
    expect(result.isErr() && result.error._tag).toBe("SearchQueryError");
  });
});

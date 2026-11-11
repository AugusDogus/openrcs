import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GMMessage } from "@/lib/gm/message";
import { Media } from "./media";
import { SessionStore } from "./session-store";
import { MessageContentSchema, Store } from "./store";
import { RcsTesting, type RcsTestEnv } from "./testing";

const key = new Uint8Array(32).fill(9);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const inline = { mimeTypes: ["image/png"], maxBytes: 1_000 };

const photo = (id: string, timestampMs: number, mimeType = "image/png") =>
  RcsTesting.message({
    id,
    conversationId: "c1",
    timestampMs,
    text: "",
    media: { id: `media-${id}`, key, mimeType, name: `${id}.png`, size: png.length },
  });

describe("Media.open", () => {
  let env: RcsTestEnv;

  beforeEach(async () => {
    env = await RcsTesting.setup();
    await RcsTesting.pair(env.db, env.ctx);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const open = (phone: ReturnType<typeof RcsTesting.fakePhone>, messageId: string, opts = { inline }) =>
    Media.open(env.db, env.ctx, messageId, { ...opts, phone: { createClient: RcsTesting.fakeClient(phone) } });

  test("returns the bytes of a stored image with its key, without asking the phone for messages", async () => {
    const message = photo("m1", 1_000);
    (await Store.upsertMessages(env.db, env.ctx, [GMMessage.toPlain(message)])).unwrap();
    const phone = RcsTesting.fakePhone({ media: new Map([["media-m1", { key, data: png }]]) });

    const opened = (await open(phone, "m1")).unwrap();
    expect(opened.info).toEqual({
      messageId: "m1",
      conversationId: "c1",
      mediaId: "media-m1",
      mimeType: "image/png",
      name: "m1.png",
      size: png.length,
    });
    expect([...(opened.bytes ?? [])]).toEqual([...png]);
    expect([...opened.grant.key]).toEqual([...key]);
    expect(phone.calls.fetchMessages).toHaveLength(0);
  });

  test("a message stored before keys were kept is fetched from the phone at its position, and the key is stored", async () => {
    const messages = [photo("m1", 1_000), photo("m2", 2_000), photo("m3", 3_000)];
    const legacy = messages.map((m) => {
      const plain = GMMessage.toPlain(m);
      return { ...plain, media: plain.media === null ? null : { ...plain.media, key: null } };
    });
    (await Store.upsertMessages(env.db, env.ctx, legacy)).unwrap();
    const phone = RcsTesting.fakePhone({
      messages: new Map([["c1", messages]]),
      media: new Map([["media-m2", { key, data: png }]]),
    });

    const opened = (await open(phone, "m2")).unwrap();
    expect([...(opened.bytes ?? [])]).toEqual([...png]);
    expect(phone.calls.fetchMessages).toHaveLength(1);
    expect(phone.calls.fetchMessages[0]?.cursor).toMatchObject({ lastItemID: "m3", lastItemTimestamp: 3_000n });
    expect((await Store.getMessage(env.db, env.ctx, "m2")).unwrap()?.media?.key).toBe(Buffer.from(key).toString("base64"));
  });

  test("other types and oversized images come back without bytes and without a download", async () => {
    (await Store.upsertMessages(env.db, env.ctx, [
      GMMessage.toPlain(photo("video", 1_000, "video/mp4")),
      GMMessage.toPlain(photo("big", 2_000)),
    ])).unwrap();
    const phone = RcsTesting.fakePhone({ media: new Map([["media-big", { key, data: new Uint8Array(5_000) }]]) });

    expect((await open(phone, "video")).unwrap().bytes).toBeNull();
    expect(phone.calls.downloadMedia).toHaveLength(0);
    // The phone reported a small size, but the download is larger than the cap.
    expect((await open(phone, "big")).unwrap().bytes).toBeNull();
    expect((await open(phone, "big", { inline: { mimeTypes: [], maxBytes: 1_000 } })).unwrap().bytes).toBeNull();
  });

  test("unknown messages and messages without an attachment are refused before the phone is used", async () => {
    (await Store.upsertMessages(env.db, env.ctx, [
      GMMessage.toPlain(RcsTesting.message({ id: "text", conversationId: "c1", timestampMs: 1_000, text: "hi" })),
    ])).unwrap();
    const phone = RcsTesting.fakePhone();
    const missing = await open(phone, "nope");
    expect(missing.isErr() && missing.error).toMatchObject({ _tag: "RcsMediaError", reason: "noMessage" });
    const plain = await open(phone, "text");
    expect(plain.isErr() && plain.error).toMatchObject({ _tag: "RcsMediaError", reason: "noMedia" });
    expect(phone.calls.connect).toBe(0);
  });

  test("a keyless message the phone no longer lists reports that there is no key", async () => {
    const plain = GMMessage.toPlain(photo("m1", 1_000));
    (await Store.upsertMessages(env.db, env.ctx, [{ ...plain, media: plain.media && { ...plain.media, key: null } }])).unwrap();
    const result = await open(RcsTesting.fakePhone(), "m1");
    expect(result.isErr() && result.error).toMatchObject({ _tag: "RcsMediaError", reason: "noKey" });
  });

  test("a download Google refuses is reported and does not mark the session for re-pairing", async () => {
    (await Store.upsertMessages(env.db, env.ctx, [GMMessage.toPlain(photo("m1", 1_000))])).unwrap();
    const wrongKey = RcsTesting.fakePhone({ media: new Map([["media-m1", { key: new Uint8Array(32), data: png }]]) });
    const refused = await open(wrongKey, "m1");
    expect(refused.isErr() && refused.error).toMatchObject({ _tag: "RcsMediaError", reason: "download", status: 403 });
    const gone = await open(RcsTesting.fakePhone(), "m1");
    expect(gone.isErr() && gone.error).toMatchObject({ reason: "download", status: 404 });
    expect(gone.isErr() && gone.error.message).toContain("no longer has this attachment");
    expect((await SessionStore.readRecord(env.db, env.userId)).unwrap()?.status).toBe("paired");
  });
});

describe("stored attachment keys", () => {
  test("content stored before keys were kept reads back with a null key", () => {
    const parsed = MessageContentSchema.parse({
      body: "",
      senderName: null,
      senderNumber: null,
      media: { mediaId: "m", mimeType: "image/png", name: "a.png", size: 1 },
      reactions: [],
    });
    expect(parsed.media).toEqual({ mediaId: "m", mimeType: "image/png", name: "a.png", size: 1, key: null });
  });

  test("toPlain keeps the key of the media id it reports", () => {
    const full = GMMessage.toPlain(photo("m1", 1_000));
    expect(full.media?.key).toBe(Buffer.from(key).toString("base64"));
  });
});

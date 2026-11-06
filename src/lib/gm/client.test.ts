import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";

import {
  GetOrCreateConversationRequestSchema as GetOrCreateRequest,
  ListConversationsRequest_Folder,
  ListConversationsRequestSchema,
  SendMessageResponse_Status,
} from "@/gen/gmproto/client_pb";
import { ActionType, MessageType } from "@/gen/gmproto/rpc_pb";
import { BrowserPresenceCheckEventSchema } from "@/gen/gmproto/events_pb";

import { AuthData } from "./auth-data";
import { GMClient, type GMClientOptions, type GMEvent, type GMTiming } from "./client";
import type { FetchFn } from "./http";
import { GMConversation, GMMessage, SendPayload } from "./message";
import { CountingClock } from "./testing/counting-clock";
import { FakeGoogle, type FakeGoogle as FakeGoogleType } from "./testing/fake-google";
import { sampleConversation, sampleMessage, type UpdateEventInit } from "./testing/fake-phone";

const FAST: Partial<GMTiming> = {
  startupAckWaitMs: 200,
  startupBacklogExtraMs: 200,
  postAckDelayMs: 5,
  ackIntervalMs: 50,
  payloadGraceMs: 150,
  reconnectBackoffMs: [10, 20],
};

const COOKIES = { SID: "sid", HSID: "hsid", SSID: "ssid", APISID: "apisid", SAPISID: "sapisid", SIDCC: "sidcc-1" };

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

let google: FakeGoogleType;
let clock: CountingClock;
let clients: GMClient[] = [];

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  google = FakeGoogle.create({ seed: 7 });
  clock = CountingClock.create();
  clients = [];
  const phone = google.phone;
  phone.conversations.push(sampleConversation("c1", "+15550000002"), sampleConversation("c2", "+15550000003"));
  phone.messages.set("c1", [sampleMessage("c1", "m1", 'héllo 😀 "quoted" [brackets]', 1_762_435_200_000_000n)]);
});

afterEach(async () => {
  for (const client of clients) await client.close();
  expect(clock.pending()).toBe(0);
  google.shutdown();
  process.off("unhandledRejection", onUnhandled);
  expect(google.errors).toEqual([]);
  expect(unhandled).toEqual([]);
});

const makeClient = (authData: AuthData, events: GMEvent[], extra: Partial<GMClientOptions> = {}): GMClient => {
  google.trustRefreshKey(authData.refreshKey);
  const client = GMClient.create({
    authData,
    fetch: google.fetch,
    onEvent: (event) => events.push(event),
    testing: { timing: FAST, clock },
    ...extra,
  });
  clients.push(client);
  return client;
};

const connected = async (authData: AuthData, events: GMEvent[] = [], extra: Partial<GMClientOptions> = {}): Promise<GMClient> => {
  const client = makeClient(authData, events, extra);
  const result = await client.connect();
  if (result.isErr()) throw new Error(`connect failed: ${result.error.message}`);
  return client;
};

describe("GMClient end to end (fake Google)", () => {
  test("connect, listConversations, fetchMessages, sendMessage; acks flushed on close; nothing left scheduled", async () => {
    const events: GMEvent[] = [];
    const client = await connected(google.phone.pairedAuthData(), events);
    expect(google.phone.activeSessionId).not.toBeNull();

    const listed = await client.listConversations({ count: 25, folder: ListConversationsRequest_Folder.INBOX });
    const conversations = listed.unwrap().conversations;
    expect(conversations.map((c) => c.conversationID)).toEqual(["c1", "c2"]);
    // The first listing of a client is a BUGLE_ANNOTATION, later ones BUGLE_MESSAGE.
    const lists = (): typeof google.phone.received => google.phone.received.filter((r) => r.action === ActionType.LIST_CONVERSATIONS);
    expect(lists()[0]?.messageType).toBe(MessageType.BUGLE_ANNOTATION);
    expect(fromBinary(ListConversationsRequestSchema, lists()[0]?.payload ?? new Uint8Array()).count).toBe(25n);
    await client.listConversations({ count: 1, folder: ListConversationsRequest_Folder.INBOX });
    expect(lists()[1]?.messageType).toBe(MessageType.BUGLE_MESSAGE);

    const messages = (await client.fetchMessages({ conversationId: "c1", count: 10 })).unwrap().messages.map(GMMessage.toPlain);
    expect(messages.map((m) => [m.body, m.timestampMs])).toEqual([['héllo 😀 "quoted" [brackets]', 1_762_435_200_000]]);

    const conversation = conversations[0];
    if (conversation === undefined) throw new Error("no conversation");
    const self = GMConversation.self(conversation);
    const sent = await client.sendMessage(
      SendPayload.text({ conversationId: "c1", text: "sent from test ✨", participantId: self.participantId, sim: self.sim, tmpId: "tmp_000000000042" }),
    );
    expect(sent.unwrap().status).toBe(SendMessageResponse_Status.SUCCESS);
    // The phone echoes the sent message as a GET_UPDATES event.
    await google.until(() => events.some((e) => e.type === "message" && e.message.tmpID === "tmp_000000000042" && !e.isOld));

    expect((await client.markRead("c1", "m1")).isOk()).toBe(true);
    expect((await client.getConversation("c2")).unwrap().conversationID).toBe("c2");
    expect((await client.listContacts()).isOk()).toBe(true);
    expect((await client.listTopContacts()).isOk()).toBe(true);
    const created = await client.getOrCreateConversation(create(GetOrCreateRequest, { numbers: SendPayload.contactNumbers(["+15550000003"]) }));
    expect(created.unwrap().conversation?.conversationID).toBe("c2");

    await client.close();
    await client.close(); // idempotent
    // Every frame the client received was acked by the time close() returned.
    expect(google.acked.length).toBeGreaterThanOrEqual(9);
    expect(new Set(google.acked).size).toBe(google.acked.length);
    expect(clock.pending()).toBe(0);
    expect(google.openStreams()).toBe(0);
    const after = await client.listContacts();
    expect(after.isErr() && after.error._tag).toBe("GMConnectionClosedError");
  });

  test("a payload-less answer is skipped and the real answer that follows is returned", async () => {
    const client = await connected(google.phone.pairedAuthData());
    // GET_CONVERSATION must return an object, so a header-only frame cannot complete it.
    google.phone.override(ActionType.GET_CONVERSATION, (req) => [{ kind: "payloadless" }, ...google.phone.handleDefault(req)]);
    const got = await client.getConversation("c1");
    expect(got.unwrap().conversationID).toBe("c1");
  });

  test("only payload-less account-switch frames fail after the grace period with GMNoResponsePayloadError", async () => {
    const events: GMEvent[] = [];
    const client = await connected(google.phone.pairedAuthData(), events);
    google.phone.override(ActionType.LIST_CONVERSATIONS, () => [{ kind: "accountField", account: "someone@example.com" }]);
    const started = Date.now();
    const res = await client.listConversations({ count: 5, folder: ListConversationsRequest_Folder.INBOX });
    if (!res.isErr() || res.error._tag !== "GMNoResponsePayloadError") throw new Error("expected GMNoResponsePayloadError");
    expect(res.error.accountSwitch).toBe(true);
    expect(res.error.frames).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(events).toContainEqual({ type: "accountChange", account: "someone@example.com", isFake: true });
  });

  test("Google-account sessions ignore unencrypted intermediate frames before the real response", async () => {
    const client = await connected(google.phone.pairedAuthData({ cookies: COOKIES }));
    google.phone.override(ActionType.LIST_MESSAGES, (req) => [{ kind: "intermediate" }, ...google.phone.handleDefault(req)]);
    const res = await client.fetchMessages({ conversationId: "c1", count: 5 });
    expect(res.unwrap().messages).toHaveLength(1);
    expect(google.requests.every((r) => !r.path.includes("ReceiveMessages") || r.hasCookie)).toBe(true);
  });

  test("an unanswered RPC fails with GMPhoneNotRespondingError after the request timeout", async () => {
    const client = await connected(google.phone.pairedAuthData(), [], { requestTimeoutMs: 80 });
    google.phone.online = false;
    const res = await client.sendMessage(SendPayload.text({ conversationId: "c1", text: "x", participantId: "", sim: null }));
    if (!res.isErr() || res.error._tag !== "GMPhoneNotRespondingError") throw new Error("expected GMPhoneNotRespondingError");
    expect(res.error.action).toBe("SEND_MESSAGE");
    expect(res.error.message).toContain("offline");
    expect(res.error.message).toContain("may still be delivered");
  });

  test("401 on a reconnecting long poll: listenFatal, pending and later calls fail with GMAuthExpiredError", async () => {
    const events: GMEvent[] = [];
    const client = await connected(google.phone.pairedAuthData(), events, { requestTimeoutMs: 5_000 });
    google.phone.online = false;
    const pending = client.listContacts();
    await google.until(() => google.phone.received.some((r) => r.action === ActionType.LIST_CONTACTS));
    google.failPolls(401);
    google.endStreams();
    const res = await pending;
    if (!res.isErr() || res.error._tag !== "GMAuthExpiredError") throw new Error("expected GMAuthExpiredError");
    expect(res.error.status).toBe(401);
    const fatal = events.find((e) => e.type === "listenFatal");
    expect(fatal?.type === "listenFatal" && fatal.error.status).toBe(401);
    const next = await client.listTopContacts();
    expect(next.isErr() && next.error._tag).toBe("GMAuthExpiredError");
  });

  test("401 when connecting returns GMAuthExpiredError and emits listenFatal", async () => {
    const events: GMEvent[] = [];
    const client = makeClient(google.phone.pairedAuthData(), events);
    google.failPolls(403);
    const res = await client.connect();
    expect(res.isErr() && res.error._tag).toBe("GMAuthExpiredError");
    expect(events.map((e) => e.type)).toContain("listenFatal");
  });

  test("the long poll reconnects when Google ends the stream, and RPCs keep working", async () => {
    const client = await connected(google.phone.pairedAuthData());
    google.endStreams();
    await google.until(() => google.pollsOpened >= 2 && google.openStreams() === 1);
    expect((await client.listContacts()).isOk()).toBe(true);
  });

  test("other long-poll errors back off and give up after a bounded number of attempts", async () => {
    const events: GMEvent[] = [];
    const client = await connected(google.phone.pairedAuthData(), events);
    google.failPolls(503, 10);
    google.endStreams();
    await google.until(() => events.filter((e) => e.type === "listenTemporary").length === 3);
    const res = await client.listContacts();
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
  });

  test("Set-Cookie rotation updates the cookies and emits authDataChanged only when a value changed", async () => {
    const events: GMEvent[] = [];
    const auth = google.phone.pairedAuthData({ cookies: COOKIES });
    const client = await connected(auth, events);
    const changed = (): number => events.filter((e) => e.type === "authDataChanged").length;
    expect(changed()).toBe(0);
    google.setCookiesOnNext({ SIDCC: "sidcc-2" });
    await client.listContacts();
    expect(auth.cookies?.SIDCC).toBe("sidcc-2");
    expect(changed()).toBe(1);
    google.setCookiesOnNext({ SIDCC: "sidcc-2" });
    await client.listContacts();
    expect(changed()).toBe(1);
  });

  test("connect refreshes a token that expires within an hour and emits authDataChanged", async () => {
    const events: GMEvent[] = [];
    const auth = google.phone.pairedAuthData({ tokenExpiresInMs: 30 * 60 * 1000 });
    const before = auth.tachyonAuthToken;
    const client = await connected(auth, events);
    expect(google.refreshes).toBe(1);
    expect(auth.tachyonAuthToken).not.toEqual(before);
    expect(events.map((e) => e.type)).toContain("authDataChanged");
    expect((await client.listContacts()).isOk()).toBe(true);
  });

  test("a rejected token refresh fails connect with GMAuthExpiredError", async () => {
    google.refreshStatus = 403;
    const client = makeClient(google.phone.pairedAuthData({ tokenExpiresInMs: 0 }), []);
    const res = await client.connect();
    expect(res.isErr() && res.error._tag === "GMAuthExpiredError" && res.error.reason).toBe("refreshRejected");
  });

  test("a rate-limited token refresh (429) fails connect without claiming the session expired", async () => {
    google.refreshStatus = 429;
    const client = makeClient(google.phone.pairedAuthData({ tokenExpiresInMs: 0 }), []);
    const res = await client.connect();
    if (!res.isErr()) throw new Error("expected connect to fail");
    expect(res.error._tag).toBe("GMRequestError");
    expect("status" in res.error && res.error.status).toBe(429);
  });

  test("startup backlog is marked isOld and acked before SetActiveSession", async () => {
    const events: GMEvent[] = [];
    const backlog = [google.phone.updateFrame({ case: "messageEvent", value: { data: [sampleMessage("c1", "old-1", "old message", 1n)] } })];
    google.queueBacklog(backlog);
    await connected(google.phone.pairedAuthData(), events);
    expect(events).toContainEqual(expect.objectContaining({ type: "message", isOld: true }));
    const order = google.requests.map((r) => (r.path.endsWith("AckMessages") ? "ack" : r.action === ActionType.GET_UPDATES ? "getUpdates" : "other"));
    expect(order.indexOf("ack")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ack")).toBeLessThan(order.indexOf("getUpdates"));
    expect(google.acked).toContain(backlog[0]?.responseID ?? "missing");
  });

  test("duplicate update events are delivered once; browser presence checks are acked; logged-out frames emit gaiaLoggedOut", async () => {
    const events: GMEvent[] = [];
    const client = await connected(google.phone.pairedAuthData(), events);
    const event: UpdateEventInit = { case: "messageEvent", value: { data: [sampleMessage("c1", "dup-1", "same", 5n)] } };
    google.push(google.phone.updateFrame(event));
    google.push(google.phone.updateFrame(event));
    google.push(google.phone.updateFrame({ case: "browserPresenceCheckEvent", value: create(BrowserPresenceCheckEventSchema) }));
    google.push(google.phone.frame(google.phone.activeSessionId ?? "", ActionType.GET_UPDATES, { kind: "plain", bytes: Uint8Array.of(0x72, 0x00) }));
    await google.until(() => google.phone.received.some((r) => r.action === ActionType.ACK_BROWSER_PRESENCE) && events.some((e) => e.type === "gaiaLoggedOut"));
    expect(events.filter((e) => e.type === "message" && e.message.messageID === "dup-1")).toHaveLength(1);
    await client.close();
  });

  test("waitForQuiet resolves once updates stop arriving, bounded by maxMs", async () => {
    const client = await connected(google.phone.pairedAuthData());
    let sent = 0;
    const timer = setInterval(() => {
      if (sent++ < 4) google.push(google.phone.updateFrame({ case: "typingEvent", value: { data: { conversationID: "c1" } } }));
    }, 20);
    const started = Date.now();
    await client.waitForQuiet({ quietMs: 60, maxMs: 2_000 });
    clearInterval(timer);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
    const bounded = Date.now();
    const noisy = setInterval(() => google.push(google.phone.updateFrame({ case: "typingEvent", value: { data: { conversationID: "c1" } } })), 10);
    await client.waitForQuiet({ quietMs: 200, maxMs: 120 });
    clearInterval(noisy);
    expect(Date.now() - bounded).toBeLessThan(400);
  });

  test("close fails pending requests with GMConnectionClosedError", async () => {
    const client = await connected(google.phone.pairedAuthData(), [], { requestTimeoutMs: 5_000 });
    google.phone.online = false;
    const pending = client.listContacts();
    await google.until(() => google.phone.received.some((r) => r.action === ActionType.LIST_CONTACTS));
    await client.close();
    const res = await pending;
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
  });

  test("close() while connect() opens the long poll: connect fails and no ack timer keeps running", async () => {
    let client: GMClient | null = null;
    const closeWhenPollOpens: FetchFn = async (input, init) => {
      const res = await google.fetch(input, init);
      if (String(input).endsWith("/ReceiveMessages")) queueMicrotask(() => void client?.close());
      return res;
    };
    client = makeClient(google.phone.pairedAuthData(), [], { fetch: closeWhenPollOpens });
    const res = await client.connect();
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, (FAST.ackIntervalMs ?? 50) * 3));
    expect(clock.pending()).toBe(0);
  });

  test("close() during connect's token refresh stops it, so AuthData does not change after close() returns", async () => {
    const events: GMEvent[] = [];
    const auth = google.phone.pairedAuthData({ tokenExpiresInMs: 10 * 60 * 1000 });
    let refreshStarted = false;
    const slowRefresh: FetchFn = async (input, init) => {
      if (String(input).endsWith("/RegisterRefresh")) {
        refreshStarted = true;
        // Like real fetch, an abort while the request is in flight rejects it.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return google.fetch(input, init);
    };
    const client = makeClient(auth, events, { fetch: slowRefresh });
    const token = auth.tachyonAuthToken;
    const connecting = client.connect();
    await google.until(() => refreshStarted);
    await client.close();
    const seen = events.length;
    const res = await connecting;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(res.isErr() && res.error._tag).toBe("GMConnectionClosedError");
    expect(events.slice(seen)).toEqual([]);
    expect(auth.tachyonAuthToken).toBe(token);
    expect(google.refreshes).toBe(0);
  });

  test("close() during SetActiveSession waits for it, so its cookie rotation is reported before close() returns", async () => {
    const events: GMEvent[] = [];
    const auth = google.phone.pairedAuthData({ cookies: COOKIES });
    let activeStarted = false;
    const slowActive: FetchFn = async (input, init) => {
      if (!String(input).endsWith("/SendMessage")) return google.fetch(input, init);
      activeStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const res = await google.fetch(input, init);
      const headers = new Headers(res.headers);
      headers.append("set-cookie", "SIDCC=sidcc-rotated; Domain=.google.com; Path=/; Secure");
      return new Response(res.body, { status: res.status, headers });
    };
    const client = makeClient(auth, events, { fetch: slowActive });
    const connecting = client.connect();
    await google.until(() => activeStarted);
    await client.close();
    const seen = events.length;
    const cookies = { ...auth.cookies };
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.slice(seen)).toEqual([]);
    expect(auth.cookies).toEqual(cookies);
    expect(cookies.SIDCC).toBe("sidcc-rotated");
  });

  test("RPCs before connect fail with GMNotConnectedError; unpaired AuthData fails connect", async () => {
    const client = makeClient(google.phone.pairedAuthData(), []);
    const early = await client.listContacts();
    expect(early.isErr() && early.error._tag).toBe("GMNotConnectedError");
    const fresh = makeClient(AuthData.createForPairing(), []);
    const res = await fresh.connect();
    expect(res.isErr() && res.error._tag === "GMNotLoggedInError" && res.error.missing).toBe("tachyonToken");
  });

  test("unpair: QR sessions revoke the relay pairing, Google-account sessions send UNPAIR_GAIA_PAIRING", async () => {
    const qr = makeClient(google.phone.pairedAuthData(), []);
    expect((await qr.unpair()).isOk()).toBe(true);
    expect(google.revokedRelays).toBe(1);
    const gaia = makeClient(google.phone.pairedAuthData({ cookies: COOKIES }), []);
    expect((await gaia.unpair()).isOk()).toBe(true);
    expect(google.phone.received.some((r) => r.action === ActionType.UNPAIR_GAIA_PAIRING)).toBe(true);
  });
});

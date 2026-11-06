import { createPublicKey, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import {
  AuthenticationContainerSchema,
  DeviceSchema,
  GaiaPairingRequestContainerSchema,
  RegisterRefreshRequestSchema,
  RevokeRelayPairingRequestSchema,
  SignInGaiaRequestSchema,
} from "@/gen/gmproto/authentication_pb";
import {
  AckMessageRequestSchema,
  CursorSchema,
  GetOrCreateConversationRequestSchema,
  ListConversationsRequest_Folder,
  ReceiveMessagesRequestSchema,
  SendMessageRequestSchema,
} from "@/gen/gmproto/client_pb";
import { MessageSchema } from "@/gen/gmproto/conversations_pb";
import { RPCPairDataSchema } from "@/gen/gmproto/events_pb";
import { ActionType, LongPollingPayloadSchema, OutgoingRPCMessageSchema } from "@/gen/gmproto/rpc_pb";
import { SIMPayloadSchema } from "@/gen/gmproto/settings_pb";

import fixture from "./__fixtures__/client.json";
import { AuthData } from "./auth-data";
import { GMRequests } from "./client";
import {
  CONTENT_TYPE_PBLITE,
  CONTENT_TYPE_PROTOBUF,
  REFRESH_PHONE_RELAY_URL,
  REGISTER_PHONE_RELAY_URL,
  REGISTER_REFRESH_URL,
  REVOKE_RELAY_PAIRING_URL,
  SIGN_IN_GAIA_URL,
} from "./constants";
import { AesCtrHelper } from "./crypto/aes-ctr";
import { Jwk } from "./crypto/jwk";
import { P256KeyPair } from "./crypto/p256";
import { PairingSession } from "./crypto/ukey2";
import { IncomingRpc, type GMEvent } from "./events";
import { GMHttp, type ContentType } from "./http";
import { GMLogger } from "./logger";
import { LongPoll } from "./longpoll";
import { SendPayload } from "./message";
import { GaiaRequests } from "./pair-gaia";
import { QrRequests } from "./pair-qr";
import { Pblite } from "./pblite";
import { SessionHandler, type SendParams } from "./session";
import { CountingClock } from "./testing/counting-clock";

// Byte-for-byte parity with libgm, using fixtures produced by
// tools/vectors/client (libgm's own request code paths, captured at the HTTP
// transport). Random values Go drew itself (request ids, IVs, signatures,
// timestamps) are recorded in the fixture and fed back in here.

type Keys = { aesKey: string; hmacKey: string; refreshKeyD: string; sessionId: string };
type State = { token: string; ttlMicros: string; mobile: string; browser: string; destRegId: string };
type Outgoing = (typeof fixture.qr.outgoing)[number];

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const baseAuth = (keys: Keys, cookies: Record<string, string> | null): AuthData => {
  const auth = AuthData.createForPairing();
  auth.requestCrypto = AesCtrHelper.fromKeys(fromHex(keys.aesKey), fromHex(keys.hmacKey)).unwrap();
  auth.refreshKey = P256KeyPair.fromPrivateScalar(fromHex(keys.refreshKeyD)).unwrap();
  auth.sessionId = keys.sessionId;
  auth.cookies = cookies === null ? null : { ...cookies };
  return auth;
};

const withState = (auth: AuthData, s: State): AuthData => ({
  ...auth,
  tachyonAuthToken: s.token === "" ? null : fromHex(s.token),
  tachyonTtlMicros: BigInt(s.ttlMicros),
  mobile: s.mobile === "" ? null : fromBinary(DeviceSchema, fromHex(s.mobile)),
  browser: s.browser === "" ? null : fromBinary(DeviceSchema, fromHex(s.browser)),
  destRegId: s.destRegId === "" ? null : s.destRegId,
});

/** Headers we send, as Go's transport saw them (lowercase names, sorted cookie pairs). */
const ourHeaders = (contentType: ContentType, cookies: Record<string, string> | null, now: Date): Record<string, string> => {
  const out: Record<string, string> = {};
  GMHttp.buildHeaders(contentType, cookies, now).forEach((value, name) => {
    out[name] = name === "cookie" ? value.split("; ").sort().join("; ") : value;
  });
  return out;
};

/** The time libgm used for SAPISIDHASH, read back from its Authorization header. */
const sapisidTime = (headers: Record<string, string | undefined>): Date => {
  const ts = /^SAPISIDHASH (\d+)_/.exec(headers.authorization ?? "")?.[1];
  return new Date(Number(ts ?? "0") * 1000);
};

const qrAuth = baseAuth(fixture.qr.keys, null);
const gaiaAuth = baseAuth(fixture.gaia.keys, fixture.gaia.cookies);

const cursor = create(CursorSchema, { lastItemID: "last-item", lastItemTimestamp: 1762435200123456n });

const qrParams: Record<string, (o: Outgoing) => SendParams> = {
  SetActiveSession: (o) => GMRequests.setActiveSession(o.requestId),
  "ListConversations first": () => GMRequests.listConversations({ count: 25, folder: ListConversationsRequest_Folder.INBOX }, true),
  "ListConversations cursor": () => GMRequests.listConversations({ count: 50, folder: ListConversationsRequest_Folder.ARCHIVE, cursor }, false),
  FetchMessages: () => GMRequests.fetchMessages({ conversationId: "conv-1", count: 30, cursor }),
  GetConversation: () => GMRequests.getConversation("conv-1"),
  GetOrCreateConversation: () =>
    GMRequests.getOrCreateConversation(create(GetOrCreateConversationRequestSchema, { numbers: SendPayload.contactNumbers(["+15551234567"]) })),
  SendMessage: () =>
    GMRequests.sendMessage(
      SendPayload.text({
        conversationId: "conv-1",
        text: 'hello ✨ "quoted"',
        participantId: "+15550001111",
        sim: create(SIMPayloadSchema, { two: 2, SIMNumber: 1 }),
        tmpId: "tmp_000000000007",
      }),
    ),
  MarkRead: () => GMRequests.markRead("conv-1", "msg-1"),
  ListContacts: () => GMRequests.listContacts(),
  ListTopContacts: () => GMRequests.listTopContacts(),
};

const gaiaSession = PairingSession.create({ uuid: fixture.gaia.attemptId, start: new Date(fixture.gaia.startMillis) });
const finishData = (o: Outgoing): Uint8Array => fromBinary(GaiaPairingRequestContainerSchema, fromHex(o.plaintext)).data;

const gaiaParams: Record<string, (o: Outgoing) => SendParams> = {
  CREATE_GAIA_PAIRING_CLIENT_INIT: () =>
    GaiaRequests.pairingMessage(gaiaSession, ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT, fromHex(fixture.gaia.initPayload)),
  "CANCEL_GAIA_PAIRING (init timeout)": () => GaiaRequests.cancel(gaiaSession),
  CREATE_GAIA_PAIRING_CLIENT_FINISHED: (o) => GaiaRequests.pairingMessage(gaiaSession, ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED, finishData(o)),
  "CANCEL_GAIA_PAIRING (finish cancelled)": () => GaiaRequests.cancel(gaiaSession),
  UNPAIR_GAIA_PAIRING: () => GMRequests.unpairGaia(fixture.gaia.attemptId),
};

const checkOutgoing = (base: AuthData, o: Outgoing, params: SendParams): void => {
  const auth = withState(base, o.auth);
  if (params.payload !== undefined) expect(toHex(params.payload.bytes)).toBe(o.plaintext);
  expect(params.payload?.kind ?? "none").toBe(o.payload);
  const { requestId, message } = SessionHandler.buildMessage(auth, o.sessionId, { ...params, requestId: o.requestId }, { iv: o.iv === "" ? undefined : fromHex(o.iv) });
  expect(requestId).toBe(o.requestId);
  expect(Pblite.marshal(OutgoingRPCMessageSchema, message)).toBe(o.body);
  expect(SessionHandler.sendUrl(auth)).toBe(o.url);
  expect(ourHeaders(CONTENT_TYPE_PBLITE, auth.cookies, sapisidTime(o.headers))).toEqual(o.headers);
};

describe("libgm parity: QR session requests", () => {
  test("RegisterPhoneRelay AuthenticationContainer (binary) and headers", () => {
    const r = fixture.qr.registerPhoneRelay;
    expect(toHex(toBinary(AuthenticationContainerSchema, QrRequests.registerPhoneRelay(qrAuth, r.requestId)))).toBe(r.bodyHex);
    expect(r.url).toBe(REGISTER_PHONE_RELAY_URL);
    expect(ourHeaders(CONTENT_TYPE_PROTOBUF, null, new Date())).toEqual(r.headers);
  });

  test("QR URL from URLData, for the first and the refreshed pairing key", () => {
    expect(QrRequests.qrUrl(fromHex(fixture.qr.qr.pairingKey), qrAuth.requestCrypto)).toBe(fixture.qr.qr.url);
    expect(QrRequests.qrUrl(fromHex(fixture.qr.qrRefreshed.pairingKey), qrAuth.requestCrypto)).toBe(fixture.qr.qrRefreshed.url);
  });

  test("RefreshPhoneRelay AuthenticationContainer", () => {
    const r = fixture.qr.refreshPhoneRelay;
    const auth = withState(qrAuth, r.auth);
    expect(toHex(toBinary(AuthenticationContainerSchema, QrRequests.refreshPhoneRelay(auth, r.requestId)))).toBe(r.bodyHex);
    expect(r.url).toBe(REFRESH_PHONE_RELAY_URL);
  });

  test.each([
    ["pairing", fixture.qr.receiveMessagesPairing],
    ["logged in", fixture.qr.receiveMessagesLoggedIn],
  ] as const)("ReceiveMessagesRequest (%s)", (_, r) => {
    const auth = withState(qrAuth, r.auth);
    expect(Pblite.marshal(ReceiveMessagesRequestSchema, LongPoll.buildRequest(auth, r.requestId))).toBe(r.body);
    expect(LongPoll.url(auth)).toBe(r.url);
    expect(ourHeaders(CONTENT_TYPE_PBLITE, null, new Date())).toEqual(r.headers);
  });

  test("RegisterRefreshRequest, with libgm's signature verified by our public key and ours by node", () => {
    const r = fixture.qr.registerRefresh;
    const auth = withState(qrAuth, r.auth);
    const timestampMicros = BigInt(r.timestampMicros);
    const signature = fromHex(r.signature);
    expect(Pblite.marshal(RegisterRefreshRequestSchema, GMRequests.registerRefresh(auth, { requestId: r.requestId, timestampMicros, signature }))).toBe(r.body);
    expect(r.url).toBe(REGISTER_REFRESH_URL);
    const key = createPublicKey({ key: Buffer.from(Jwk.publicKeySpkiDer(auth.refreshKey)), format: "der", type: "spki" });
    const signed = Buffer.from(`${r.requestId}:${r.timestampMicros}`);
    expect(verify("sha256", signed, { key, dsaEncoding: "der" }, signature)).toBe(true);
    const ours = Jwk.signRequest(auth.refreshKey, r.requestId, timestampMicros);
    expect(verify("sha256", signed, { key, dsaEncoding: "der" }, ours)).toBe(true);
  });

  test.each(fixture.qr.outgoing.map((o) => [o.name, o] as const))("OutgoingRPCMessage: %s", (name, o) => {
    const build = qrParams[name];
    if (build === undefined) throw new Error(`no TS builder for ${name}`);
    checkOutgoing(qrAuth, o, build(o));
  });

  test("AckMessageRequest acks every received frame in order", () => {
    const r = fixture.qr.ack;
    const auth = withState(qrAuth, r.auth);
    expect(Pblite.marshal(AckMessageRequestSchema, SessionHandler.buildAckRequest(auth, r.requestId, r.ackIds))).toBe(r.body);
    expect(SessionHandler.ackUrl(auth)).toBe(r.url);
    const dataFrames = fixture.qr.frames.filter((f) => f.route === 19).map((f) => f.responseId);
    expect(r.ackIds).toEqual(dataFrames);
  });

  test("RevokeRelayPairingRequest", () => {
    const r = fixture.qr.revokeRelayPairing;
    const auth = withState(qrAuth, r.auth);
    expect(toHex(toBinary(RevokeRelayPairingRequestSchema, GMRequests.revokeRelayPairing(auth, r.requestId)))).toBe(r.bodyHex);
    expect(r.url).toBe(REVOKE_RELAY_PAIRING_URL);
  });
});

describe("libgm parity: Gaia session requests", () => {
  test("SignInGaiaRequest with cookies and SAPISIDHASH headers", () => {
    const r = fixture.gaia.signInGaia;
    expect(Pblite.marshal(SignInGaiaRequestSchema, GaiaRequests.signIn(gaiaAuth, r.requestId))).toBe(r.body);
    expect(r.url).toBe(SIGN_IN_GAIA_URL);
    expect(ourHeaders(CONTENT_TYPE_PBLITE, gaiaAuth.cookies, sapisidTime(r.headers))).toEqual(r.headers);
  });

  test("ReceiveMessagesRequest uses the Google endpoint and GDitto network", () => {
    const r = fixture.gaia.receiveMessages;
    const auth = withState(gaiaAuth, r.auth);
    expect(Pblite.marshal(ReceiveMessagesRequestSchema, LongPoll.buildRequest(auth, r.requestId))).toBe(r.body);
    expect(LongPoll.url(auth)).toBe(r.url);
    expect(ourHeaders(CONTENT_TYPE_PBLITE, auth.cookies, sapisidTime(r.headers))).toEqual(r.headers);
  });

  test.each(fixture.gaia.outgoing.map((o) => [o.name, o] as const))("OutgoingRPCMessage: %s", (name, o) => {
    const build = gaiaParams[name];
    if (build === undefined) throw new Error(`no TS builder for ${name}`);
    checkOutgoing(gaiaAuth, o, build(o));
  });

  test("SignInGaia device id is messages-web- + hex of the nil session id", () => {
    const inner = fromBinary(SignInGaiaRequestSchema, toBinary(SignInGaiaRequestSchema, GaiaRequests.signIn(gaiaAuth, "x"))).inner;
    expect(inner?.deviceID?.deviceID).toBe(`messages-web-${"0".repeat(32)}`);
  });
});

describe("libgm parity: send payload", () => {
  test("SendMessageRequest from BuildSendPayloadWithTmpID", () => {
    const p = fixture.sendPayload;
    const req = SendPayload.text({
      conversationId: p.conversationId,
      text: p.text,
      participantId: p.participantId,
      sim: create(SIMPayloadSchema, { two: p.simTwo, SIMNumber: p.simNumber }),
      replyToId: p.replyToId,
      tmpId: p.tmpId,
    });
    expect(toHex(toBinary(SendMessageRequestSchema, req))).toBe(p.binary);
  });
});

describe("libgm parity: response acceptance (receiveResponse)", () => {
  const acceptCrypto = AesCtrHelper.fromKeys(fromHex(fixture.acceptance.keys.aesKey), fromHex(fixture.acceptance.keys.hmacKey)).unwrap();

  test.each(fixture.acceptance.cases.map((c) => [`${c.session}: ${c.name}`, c] as const))("%s", async (_, c) => {
    const auth = AuthData.createForPairing();
    auth.requestCrypto = acceptCrypto;
    if (c.session === "gaiaNoCookies") auth.destRegId = fixture.acceptance.destRegId;
    const clock = CountingClock.create();
    const handler = SessionHandler.create({
      http: {
        fetch: async () => new Response("[]", { headers: { "content-type": CONTENT_TYPE_PBLITE } }),
        authData: auth,
        logger: GMLogger.noop,
        clock,
        onCookiesChanged: () => {},
      },
      timing: { requestTimeoutMs: 1_000, payloadGraceMs: 10_000, ackIntervalMs: 5_000 },
    });
    const pending = (await handler.sendAsync({ action: c.waiterAction, requestId: "req-1" })).unwrap();
    const raw = Pblite.unmarshal(LongPollingPayloadSchema, c.json).unwrap().data;
    if (raw === undefined) throw new Error("frame has no data");
    const { rpc } = IncomingRpc.decode(raw, acceptCrypto).unwrap();
    expect(handler.receiveResponse(rpc)).toBe(c.consumed);
    const outcome = await pending.wait({ timeoutMs: 0 });
    expect(outcome.kind === "response").toBe(c.delivered);
    expect(clock.pending()).toBe(0);
  });
});

describe("libgm parity: incoming frames", () => {
  const crypto = qrAuth.requestCrypto;

  test.each(fixture.qr.frames.map((f) => [f.name, f] as const))("decrypts and decodes %s identically", (_, f) => {
    const payload = Pblite.unmarshal(LongPollingPayloadSchema, f.json).unwrap();
    const raw = payload.data;
    if (raw === undefined) throw new Error("frame has no data");
    expect(raw.responseID).toBe(f.responseId);
    const { rpc, accountChange } = IncomingRpc.decode(raw, crypto).unwrap();
    expect(raw.bugleRoute).toBe(f.route);
    if (rpc.route === "pair") {
      expect(toHex(toBinary(RPCPairDataSchema, rpc.pair))).toBe(f.pair);
      return;
    }
    if (rpc.route !== "data") throw new Error(`unexpected route ${rpc.route}`);
    expect(rpc.data.action).toBe(f.action);
    expect(toHex(rpc.decryptedData ?? new Uint8Array())).toBe(f.decryptedData);
    expect(rpc.decrypted?.$typeName ?? "").toBe(f.decodedType);
    if (f.decoded !== "") {
      const schema = IncomingRpc.responseSchema(rpc.data.action);
      if (schema === undefined || rpc.decrypted === null) throw new Error("no decoded message");
      expect(toHex(toBinary(schema, rpc.decrypted))).toBe(f.decoded);
    }
    expect(rpc.shape.hasPayload).toBe(f.hasPayload);
    expect(rpc.shape.hasUnencrypted).toBe(f.hasUnencrypted);
    expect(rpc.shape.hasAccountField).toBe(f.hasAccountField);
    expect(rpc.shape.accountSwitch).toBe(f.accountSwitch);
    expect(accountChange !== null).toBe(f.accountSwitch);
  });

  test("routing the data frames yields the events libgm's HandleRPCMsg emitted", () => {
    const dedup = IncomingRpc.createDedup();
    const events: GMEvent[] = [];
    for (const f of fixture.qr.frames) {
      const raw = Pblite.unmarshal(LongPollingPayloadSchema, f.json).unwrap().data;
      if (raw === undefined) continue;
      const { rpc, accountChange } = IncomingRpc.decode(raw, crypto).unwrap();
      if (rpc.route !== "data") continue;
      if (accountChange !== null) events.push({ type: "accountChange", account: accountChange.account, isFake: true });
      for (const effect of IncomingRpc.routeUpdate(rpc, false, dedup, GMLogger.noop)) {
        if (effect.kind === "event") events.push(effect.event);
      }
    }
    type SimpleEvent = { type: string; message?: string; account?: string; isFake?: boolean };
    const simplified: SimpleEvent[] = events.map((e) =>
      e.type === "message"
        ? { type: "message", message: toHex(toBinary(MessageSchema, e.message)) }
        : e.type === "accountChange"
          ? { type: "accountChange", account: e.account, isFake: e.isFake }
          : { type: e.type },
    );
    const fromGo: SimpleEvent[] = fixture.qr.events.map((e) =>
      e.type === "message"
        ? { type: "message", message: "message" in e ? e.message : "" }
        : e.type === "accountChange"
          ? { type: "accountChange", account: "account" in e ? e.account : "", isFake: "isFake" in e ? e.isFake : false }
          : { type: e.type },
    );
    expect(simplified).toEqual(fromGo);
  });

  test("the frames streamed as one ReceiveMessages body parse identically at every chunk boundary", () => {
    const body = new TextEncoder().encode(`[[${fixture.qr.frames.map((f) => f.json).join(",")}]]`);
    const expected = fixture.qr.frames.map((f) => f.responseId);
    for (let split = 1; split < body.length; split++) {
      const parser = LongPoll.createParser();
      const events = [...parser.push(body.subarray(0, split)).unwrap(), ...parser.push(body.subarray(split)).unwrap()];
      const ids = events.flatMap((e) => (e.kind === "frame" && e.frame.kind === "data" ? [e.frame.message.responseID] : []));
      expect(ids).toEqual(expected);
      expect(parser.ended()).toBe(true);
    }
  });
});

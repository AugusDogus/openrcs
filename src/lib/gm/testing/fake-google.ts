import { createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

import {
  AuthenticationContainerSchema,
  ErrorResponseSchema,
  RefreshPhoneRelayResponseSchema,
  RegisterPhoneRelayResponseSchema,
  RegisterRefreshRequestSchema,
  RegisterRefreshResponseSchema,
  RevokeRelayPairingRequestSchema,
  RevokeRelayPairingResponseSchema,
  SignInGaiaRequestSchema,
  SignInGaiaResponseSchema,
} from "@/gen/gmproto/authentication_pb";
import { AckMessageRequestSchema, ReceiveMessagesRequestSchema } from "@/gen/gmproto/client_pb";
import {
  LongPollingPayloadSchema,
  OutgoingRPCDataSchema,
  OutgoingRPCMessageSchema,
  OutgoingRPCResponseSchema,
  type ActionType,
  type IncomingRPCMessage,
} from "@/gen/gmproto/rpc_pb";

import { CONTENT_TYPE_PBLITE, CONTENT_TYPE_PROTOBUF, MESSAGES_BASE_URL } from "../constants";
import type { Jwk as JwkType } from "../crypto/jwk";
import { Jwk } from "../crypto/jwk";
import { sapisidHash } from "../crypto/sapisid";
import { Pblite } from "../pblite";
import { FakePhone } from "./fake-phone";

// Fake Google Messages endpoints for end-to-end tests, as an injectable fetch.
// The long poll streams "[[" + frames + "]]" in small, seeded-random chunks
// that split JSON strings, escapes and multi-byte UTF-8 sequences.

export type RecordedRequest = {
  readonly path: string;
  readonly status: number;
  /** OutgoingRPCData.action for SendMessage requests. */
  readonly action: ActionType | null;
  readonly hasCookie: boolean;
  readonly authorization: string | null;
};

type PollStream = {
  readonly id: number;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  open: boolean;
  wroteFrame: boolean;
};

export type GaiaDevices = "one" | "two" | "none";

export type FakeGoogle = {
  readonly fetch: typeof fetch;
  readonly phone: FakePhone;
  readonly requests: RecordedRequest[];
  /** Response ids acknowledged through AckMessages. */
  readonly acked: string[];
  /** Harness-side failures (bad requests the fake could not handle); tests assert it stays empty. */
  readonly errors: string[];
  refreshes: number;
  revokedRelays: number;
  pollsOpened: number;
  gaiaDevices: GaiaDevices;
  /** SignInGaia answers 401. */
  rejectCookies: boolean;
  /** RegisterRefresh answers this status instead of a token. */
  refreshStatus: number | null;
  /** Lets RegisterRefresh accept signatures from this key. */
  trustRefreshKey(key: JwkType): void;
  /** The next `count` long polls answer `status`. */
  failPolls(status: number, count?: number): void;
  /** The next response of any endpoint carries these Set-Cookie values. */
  setCookiesOnNext(cookies: Record<string, string>): void;
  /** Delivered at the next long-poll open, announced by its ack-count frame. */
  queueBacklog(frames: readonly IncomingRPCMessage[]): void;
  /** Delivers a frame on the open long poll (queued until one opens). */
  push(frame: IncomingRPCMessage): void;
  /** Ends every open stream with "]]", as Google does periodically. */
  endStreams(): void;
  openStreams(): number;
  /** Resolves once `predicate` holds (checked every 5 ms); rejects after `timeoutMs`. */
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Ends all streams. */
  shutdown(): void;
};

/** Small deterministic PRNG (mulberry32). */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const pbliteResponse = <Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, status = 200): { status: number; type: string; body: string } => ({
  status,
  type: `${CONTENT_TYPE_PBLITE}; charset=UTF-8`,
  body: Pblite.marshal(schema, message),
});

const binaryResponse = <Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): { status: number; type: string; body: Uint8Array } => ({
  status: 200,
  type: CONTENT_TYPE_PROTOBUF,
  body: toBinary(schema, message),
});

const errorResponse = (status: number, message: string): { status: number; type: string; body: string } =>
  pbliteResponse(ErrorResponseSchema, create(ErrorResponseSchema, { type: 16n, message }), status);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export const FakeGoogle = {
  create(opts: { readonly phone?: FakePhone; readonly seed?: number; readonly maxChunk?: number } = {}): FakeGoogle {
    const phone = opts.phone ?? FakePhone.create();
    const random = rng(opts.seed ?? 1);
    const maxChunk = opts.maxChunk ?? 23;
    const streams: PollStream[] = [];
    const queued: IncomingRPCMessage[] = [];
    let backlog: IncomingRPCMessage[] = [];
    let pollFailures: number[] = [];
    let nextCookies: Record<string, string> | null = null;
    let streamIds = 0;
    const validTokens: Uint8Array[] = [phone.pairedToken];
    const refreshKeys: KeyObject[] = [];
    const relayToken = new Uint8Array(randomBytes(16));

    const tokenValid = (token: Uint8Array): boolean => validTokens.some((t) => equalBytes(t, token));

    const enqueue = (stream: PollStream, text: string): void => {
      const bytes = encoder.encode(text);
      let offset = 0;
      while (offset < bytes.length && stream.open) {
        const size = 1 + Math.floor(random() * maxChunk);
        try {
          stream.controller.enqueue(bytes.slice(offset, offset + size));
        } catch {
          stream.open = false;
        }
        offset += size;
      }
    };

    const writeFrame = (stream: PollStream, payload: MessageInitShape<typeof LongPollingPayloadSchema>): void => {
      const text = Pblite.marshal(LongPollingPayloadSchema, create(LongPollingPayloadSchema, payload));
      enqueue(stream, (stream.wroteFrame ? "," : "") + text);
      stream.wroteFrame = true;
    };

    const current = (): PollStream | undefined => streams.filter((s) => s.open).at(-1);

    const deliver = (frame: IncomingRPCMessage): void => {
      const stream = current();
      if (stream === undefined) queued.push(frame);
      else writeFrame(stream, { data: frame });
    };

    const closeStream = (stream: PollStream, end: boolean): void => {
      if (!stream.open) return;
      if (end) enqueue(stream, "]]");
      stream.open = false;
      try {
        stream.controller.close();
      } catch {
        // already cancelled by the reader
      }
    };

    const openPoll = (signal: AbortSignal | null): ReadableStream<Uint8Array> => {
      google.pollsOpened++;
      let stream: PollStream | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = { id: ++streamIds, controller, open: true, wroteFrame: false };
        },
        cancel() {
          if (stream !== null) stream.open = false;
        },
      });
      if (stream === null) throw new Error("ReadableStream start() did not run synchronously");
      const s: PollStream = stream;
      streams.push(s);
      signal?.addEventListener(
        "abort",
        () => {
          if (!s.open) return;
          s.open = false;
          try {
            s.controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            // already closed
          }
        },
        { once: true },
      );
      enqueue(s, "[[");
      const startup = backlog;
      backlog = [];
      writeFrame(s, { ack: { count: startup.length } });
      writeFrame(s, { heartbeat: {} });
      for (const frame of startup) writeFrame(s, { data: frame });
      for (const frame of queued.splice(0)) writeFrame(s, { data: frame });
      return body;
    };

    type Answer = { status: number; type: string; body: string | Uint8Array | ReadableStream<Uint8Array>; action?: ActionType };

    const handle = async (path: string, headers: Headers, body: Uint8Array, signal: AbortSignal | null): Promise<Answer> => {
      const text = (): string => decoder.decode(body);
      switch (path.split("/").pop()) {
        case "ReceiveMessages": {
          const failure = pollFailures.shift();
          if (failure !== undefined) return errorResponse(failure, "Request had invalid authentication credentials.");
          const req = Pblite.unmarshal(ReceiveMessagesRequestSchema, text()).unwrap();
          const token = req.auth?.tachyonAuthToken ?? new Uint8Array(0);
          if (!tokenValid(token) && !equalBytes(token, relayToken)) return errorResponse(401, "Request had invalid authentication credentials.");
          return { status: 200, type: `${CONTENT_TYPE_PBLITE}; charset=UTF-8`, body: openPoll(signal) };
        }
        case "SendMessage": {
          const message = Pblite.unmarshal(OutgoingRPCMessageSchema, text()).unwrap();
          const token = message.auth?.tachyonAuthToken ?? new Uint8Array(0);
          if (!tokenValid(token) && !equalBytes(token, relayToken)) return errorResponse(401, "Request had invalid authentication credentials.");
          const data = fromBinary(OutgoingRPCDataSchema, message.data?.messageData ?? new Uint8Array(0));
          const frames = phone.handle(data, {
            messageType: message.data?.messageTypeData?.messageType ?? 0,
            ttlMicros: message.TTL,
            destRegIds: message.destRegistrationIDs,
          });
          queueMicrotask(() => {
            for (const frame of frames) deliver(frame);
          });
          return { ...pbliteResponse(OutgoingRPCResponseSchema, create(OutgoingRPCResponseSchema, { timestamp: String(Date.now()) })), action: data.action };
        }
        case "AckMessages": {
          const req = Pblite.unmarshal(AckMessageRequestSchema, text()).unwrap();
          for (const ack of req.acks) google.acked.push(ack.requestID);
          return pbliteResponse(OutgoingRPCResponseSchema, create(OutgoingRPCResponseSchema));
        }
        case "RegisterRefresh": {
          if (google.refreshStatus !== null) return errorResponse(google.refreshStatus, "The caller does not have permission");
          const req = Pblite.unmarshal(RegisterRefreshRequestSchema, text()).unwrap();
          const signed = Buffer.from(`${req.messageAuth?.requestID ?? ""}:${req.unixTimestamp.toString()}`);
          const ok = refreshKeys.some((key) => verify("sha256", signed, { key, dsaEncoding: "der" }, req.signature));
          if (!ok) return errorResponse(401, "Request had invalid authentication credentials.");
          google.refreshes++;
          const token = new Uint8Array(randomBytes(24));
          validTokens.push(token);
          return pbliteResponse(RegisterRefreshResponseSchema, create(RegisterRefreshResponseSchema, { tokenData: { tachyonAuthToken: token, TTL: 86_400_000_000n } }));
        }
        case "SignInGaia": {
          const cookies = Object.fromEntries(
            (headers.get("cookie") ?? "").split(";").map((part) => {
              const [name = "", ...rest] = part.trim().split("=");
              return [name, rest.join("=")];
            }),
          );
          const sapisid = cookies.SAPISID ?? "";
          const authorization = headers.get("authorization") ?? "";
          const ts = Number(/^SAPISIDHASH (\d+)_/.exec(authorization)?.[1] ?? "0");
          const signedOk = sapisid !== "" && authorization === sapisidHash(MESSAGES_BASE_URL, sapisid, ts);
          if (google.rejectCookies || !signedOk || ["SID", "HSID", "SSID", "APISID"].some((n) => (cookies[n] ?? "") === "")) {
            return errorResponse(401, "Request had invalid authentication credentials.");
          }
          const req = Pblite.unmarshal(SignInGaiaRequestSchema, text()).unwrap();
          const spki = req.inner?.someData?.someData;
          if (spki !== undefined) refreshKeys.push(createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }));
          const other = randomUUID();
          const items2 =
            google.gaiaDevices === "none"
              ? [{ destOrSourceUUID: other, unknownInt4: 6 }]
              : google.gaiaDevices === "one"
                ? [{ destOrSourceUUID: phone.regId, unknownInt4: 1, languageCode: "en", unknownBigInt7: 42n }, { destOrSourceUUID: other, unknownInt4: 6 }]
                : [
                    { destOrSourceUUID: other, unknownInt4: 1, unknownBigInt7: 7n },
                    { destOrSourceUUID: phone.regId, unknownInt4: 1, languageCode: "en", unknownBigInt7: 42n },
                  ];
          return pbliteResponse(
            SignInGaiaResponseSchema,
            create(SignInGaiaResponseSchema, {
              deviceData: {
                deviceWrapper: { device: phone.browser },
                unknownItems2: items2,
                unknownItems3: [
                  { destOrSourceUUID: other, unknownTimestampMicroseconds: 1_000_000n },
                  { destOrSourceUUID: phone.regId, unknownTimestampMicroseconds: BigInt(Date.now()) * 1000n },
                ],
              },
              tokenData: { tachyonAuthToken: phone.pairedToken, TTL: 86_400_000_000n },
            }),
          );
        }
        case "RegisterPhoneRelay": {
          const req = fromBinary(AuthenticationContainerSchema, body);
          if (req.data.case !== "keyData") return errorResponse(400, "missing key data");
          const spki = req.data.value.ecdsaKeys?.encryptedKeys ?? new Uint8Array(0);
          refreshKeys.push(createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }));
          return binaryResponse(
            RegisterPhoneRelayResponseSchema,
            create(RegisterPhoneRelayResponseSchema, {
              pairingKey: new Uint8Array(randomBytes(32)),
              authKeyData: { tachyonAuthToken: relayToken, TTL: 86_400_000_000n },
              validFor: 30_000_000n,
            }),
          );
        }
        case "RefreshPhoneRelay": {
          const req = fromBinary(AuthenticationContainerSchema, body);
          if (!equalBytes(req.authMessage?.tachyonAuthToken ?? new Uint8Array(0), relayToken)) return errorResponse(401, "bad relay token");
          return binaryResponse(RefreshPhoneRelayResponseSchema, create(RefreshPhoneRelayResponseSchema, { pairKey: new Uint8Array(randomBytes(32)) }));
        }
        case "RevokeRelayPairing": {
          fromBinary(RevokeRelayPairingRequestSchema, body);
          google.revokedRelays++;
          return binaryResponse(RevokeRelayPairingResponseSchema, create(RevokeRelayPairingResponseSchema));
        }
        default:
          return { status: 404, type: "text/plain", body: "not found" };
      }
    };

    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const signal = init?.signal ?? null;
      const abortError = (): DOMException => new DOMException("The operation was aborted.", "AbortError");
      if (signal?.aborted) throw abortError();
      const headers = new Headers(init?.headers);
      const body = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
      // Like real fetch: an abort while the request is in flight rejects it.
      if (signal?.aborted) throw abortError();
      const path = new URL(url).pathname;
      let answer: Answer;
      try {
        answer = await handle(path, headers, body, signal);
      } catch (cause) {
        google.errors.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
        answer = { status: 500, type: "text/plain", body: "fake google failed" };
      }
      if (signal?.aborted) {
        if (answer.body instanceof ReadableStream) await answer.body.cancel();
        throw abortError();
      }
      const cookies = nextCookies;
      nextCookies = null;
      const record = (status: number, action: ActionType | null): void => {
        google.requests.push({ path, status, action, hasCookie: headers.has("cookie"), authorization: headers.get("authorization") });
      };
      record(answer.status, answer.action ?? null);
      const responseHeaders = new Headers({ "content-type": answer.type });
      if (cookies !== null) {
        for (const [name, value] of Object.entries(cookies)) responseHeaders.append("set-cookie", `${name}=${value}; Domain=.google.com; Path=/; Secure; HttpOnly`);
      }
      const payload = answer.body;
      return new Response(typeof payload === "string" || payload instanceof ReadableStream ? payload : new Uint8Array(payload), {
        status: answer.status,
        headers: responseHeaders,
      });
    };

    const google: FakeGoogle = {
      fetch: Object.assign(fakeFetch, { preconnect: () => {} }),
      phone,
      requests: [],
      acked: [],
      errors: [],
      refreshes: 0,
      revokedRelays: 0,
      pollsOpened: 0,
      gaiaDevices: "one",
      rejectCookies: false,
      refreshStatus: null,
      trustRefreshKey(key) {
        refreshKeys.push(createPublicKey({ key: Buffer.from(Jwk.publicKeySpkiDer(key)), format: "der", type: "spki" }));
      },
      failPolls(status, count = 1) {
        pollFailures = [...pollFailures, ...Array.from({ length: count }, () => status)];
      },
      setCookiesOnNext(cookies) {
        nextCookies = { ...cookies };
      },
      queueBacklog(frames) {
        backlog = [...backlog, ...frames];
      },
      push: deliver,
      endStreams() {
        for (const stream of streams) closeStream(stream, true);
      },
      openStreams: () => streams.filter((s) => s.open).length,
      until(predicate, timeoutMs = 2_000) {
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const tick = (): void => {
            if (predicate()) resolve();
            else if (Date.now() - started > timeoutMs) reject(new Error(`condition not met within ${timeoutMs} ms`));
            else setTimeout(tick, 5);
          };
          tick();
        });
      },
      shutdown() {
        for (const stream of streams) closeStream(stream, false);
      },
    };
    return google;
  },
} as const;

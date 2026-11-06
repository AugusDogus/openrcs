import { randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { Result } from "better-result";

import { AckMessageRequestSchema, type AckMessageRequest } from "@/gen/gmproto/client_pb";
import {
  ActionType,
  BugleRoute,
  MessageType,
  OutgoingRPCDataSchema,
  OutgoingRPCMessageSchema,
  OutgoingRPCResponseSchema,
  type OutgoingRPCMessage,
} from "@/gen/gmproto/rpc_pb";

import { AuthData } from "./auth-data";
import type { TimerHandle } from "./clock";
import {
  ACK_MESSAGES_URL,
  ACK_MESSAGES_URL_GOOGLE,
  configVersion,
  CONTENT_TYPE_PBLITE,
  SEND_MESSAGE_URL,
  SEND_MESSAGE_URL_GOOGLE,
} from "./constants";
import { AesCtrHelper } from "./crypto/aes-ctr";
import {
  GMAuthExpiredError,
  GMConnectionClosedError,
  GMNoResponsePayloadError,
  GMPhoneNotRespondingError,
  type GMTransportError,
} from "./errors";
import { actionName, IncomingRpc, type DataRpc, type IncomingRpc as IncomingRpcType, type ResponseShape } from "./events";
import { GMHttp, type HttpContext } from "./http";

// libgm session_handler.go, response_acceptance.go and request_timeout.go:
// building OutgoingRPCMessages, matching responses to waiters by request id,
// payload-less answer handling, request timeouts, and acks.

/** libgm SendMessageParams TTL rules as one value: CustomTTL, OmitTTL, or the tachyon TTL. */
export type TtlMode = "tachyon" | "omit" | { readonly customMicros: bigint };

export type RequestPayload =
  | { readonly kind: "encrypted"; readonly bytes: Uint8Array }
  /** libgm DontEncrypt: sent as OutgoingRPCData.unencryptedProtoData (Gaia pairing). */
  | { readonly kind: "plain"; readonly bytes: Uint8Array };

export type SendParams = {
  readonly action: ActionType;
  /** Serialized request protobuf; omitted for actions without data. */
  readonly payload?: RequestPayload;
  readonly requestId?: string;
  /** Default "tachyon". */
  readonly ttl?: TtlMode;
  /** Default BUGLE_MESSAGE (libgm treats 0 the same way). */
  readonly messageType?: MessageType;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_PAYLOAD_GRACE_MS = 10_000;
export const DEFAULT_ACK_INTERVAL_MS = 5_000;

/** libgm payloadRequired. */
const PAYLOAD_REQUIRED: ReadonlySet<ActionType> = new Set([
  ActionType.LIST_CONVERSATIONS,
  ActionType.LIST_MESSAGES,
  ActionType.GET_OR_CREATE_CONVERSATION,
  ActionType.GET_CONVERSATION,
  ActionType.GET_CONVERSATION_TYPE,
  ActionType.LIST_CONTACTS,
  ActionType.LIST_TOP_CONTACTS,
  ActionType.GET_PARTICIPANTS_THUMBNAIL,
  ActionType.GET_CONTACTS_THUMBNAIL,
  ActionType.GET_FULL_SIZE_IMAGE,
]);

/** libgm objectRequired. */
const OBJECT_REQUIRED: ReadonlySet<ActionType> = new Set([
  ActionType.GET_OR_CREATE_CONVERSATION,
  ActionType.GET_CONVERSATION,
  ActionType.GET_CONVERSATION_TYPE,
  ActionType.GET_FULL_SIZE_IMAGE,
]);

/** libgm rejectsPayloadless. */
const rejectsPayloadless = (action: ActionType, shape: ResponseShape): boolean => {
  if (shape.hasPayload || !PAYLOAD_REQUIRED.has(action)) return false;
  if (shape.hasAccountField) return true;
  return OBJECT_REQUIRED.has(action) && !shape.hasUnencrypted;
};

/** libgm buildMessage. `iv` fixes the encryption IV (tests only). */
const buildMessage = (
  authData: AuthData,
  sessionId: string,
  params: SendParams,
  opts: { readonly iv?: Uint8Array } = {},
): { readonly requestId: string; readonly message: OutgoingRPCMessage } => {
  const requestId = params.requestId === undefined || params.requestId === "" ? randomUUID() : params.requestId;
  const messageType =
    params.messageType === undefined || params.messageType === MessageType.UNKNOWN_MESSAGE_TYPE
      ? MessageType.BUGLE_MESSAGE
      : params.messageType;
  const ttlMode = params.ttl ?? "tachyon";
  const ttl =
    typeof ttlMode === "object" && ttlMode.customMicros !== 0n
      ? ttlMode.customMicros
      : ttlMode === "omit"
        ? 0n
        : authData.tachyonTtlMicros;
  const payload = params.payload;
  const empty = new Uint8Array(0);
  const encryptedProtoData =
    payload?.kind === "encrypted" ? AesCtrHelper.encrypt(authData.requestCrypto, payload.bytes, opts.iv) : empty;
  const unencryptedProtoData = payload?.kind === "plain" ? payload.bytes : empty;
  const messageData = toBinary(
    OutgoingRPCDataSchema,
    create(OutgoingRPCDataSchema, {
      requestID: requestId,
      action: params.action,
      unencryptedProtoData,
      encryptedProtoData,
      sessionID: sessionId,
    }),
  );
  const message = create(OutgoingRPCMessageSchema, {
    mobile: authData.mobile ?? undefined,
    data: {
      requestID: requestId,
      bugleRoute: BugleRoute.DataEvent,
      messageTypeData: { emptyArr: {}, messageType },
      messageData,
    },
    auth: {
      requestID: requestId,
      tachyonAuthToken: authData.tachyonAuthToken ?? empty,
      configVersion: configVersion(),
    },
    TTL: ttl,
    destRegistrationIDs: authData.destRegId === null ? [] : [authData.destRegId],
  });
  return { requestId, message };
};

/** libgm sendAckRequest's AckMessageRequest. */
const buildAckRequest = (authData: AuthData, requestId: string, responseIds: readonly string[]): AckMessageRequest =>
  create(AckMessageRequestSchema, {
    authData: {
      requestID: requestId,
      tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
      network: AuthData.authNetwork(authData),
      configVersion: configVersion(),
    },
    emptyArr: {},
    acks: responseIds.map((id) => ({ requestID: id, device: authData.browser ?? undefined })),
  });

const sendUrl = (authData: AuthData): string => (AuthData.hasCookies(authData) ? SEND_MESSAGE_URL_GOOGLE : SEND_MESSAGE_URL);
const ackUrl = (authData: AuthData): string => (AuthData.hasCookies(authData) ? ACK_MESSAGES_URL_GOOGLE : ACK_MESSAGES_URL);

/** Why pending requests are failed in bulk. */
export type PendingFailure = { readonly kind: "closed"; readonly detail: string } | { readonly kind: "authExpired"; readonly status: number };

type Terminal =
  | { readonly kind: "response"; readonly rpc: DataRpc }
  | { readonly kind: "failed"; readonly error: GMNoResponsePayloadError | GMConnectionClosedError | GMAuthExpiredError };

export type WaitOutcome = Terminal | { readonly kind: "timeout"; readonly error: GMPhoneNotRespondingError | GMNoResponsePayloadError } | { readonly kind: "aborted" };

type Waiter = {
  readonly action: ActionType;
  readonly sentAt: number;
  skipped: number;
  lastShape: ResponseShape | null;
  accountSwitch: boolean;
  graceTimer: TimerHandle | null;
  settled: boolean;
  readonly settle: (outcome: Terminal) => void;
  readonly done: Promise<Terminal>;
};

export type PendingRequest = {
  readonly requestId: string;
  readonly action: ActionType;
  /** Waits for the answer, up to `timeoutMs` (null: no timeout) or until `signal` aborts. Never rejects. */
  wait(opts: { readonly timeoutMs: number | null; readonly signal?: AbortSignal }): Promise<WaitOutcome>;
};

export type SessionTiming = {
  readonly requestTimeoutMs: number;
  readonly payloadGraceMs: number;
  readonly ackIntervalMs: number;
};

export type SessionHandler = {
  /** Session id used in OutgoingRPCData (libgm sessionHandler.sessionID). */
  readonly sessionId: () => string;
  /** libgm ResetSessionID. */
  resetSessionId(): string;
  sendNoResponse(params: SendParams): Promise<Result<void, GMTransportError>>;
  sendAsync(params: SendParams): Promise<Result<PendingRequest, GMTransportError>>;
  /** sendAsync + wait with the request timeout (libgm sendMessageWithParams). */
  send(params: SendParams): Promise<Result<DataRpc, GMTransportError | GMPhoneNotRespondingError | GMNoResponsePayloadError | GMConnectionClosedError | GMAuthExpiredError>>;
  /** libgm receiveResponse: true when the frame was consumed by a waiter. */
  receiveResponse(rpc: IncomingRpcType): boolean;
  queueAck(responseId: string): void;
  /** Sends queued acks now. Never rejects; failures are logged. */
  flushAcks(): Promise<void>;
  startAckInterval(): void;
  stopAckInterval(): void;
  /** Fails every pending request; returns how many. */
  failPending(reason: PendingFailure): number;
  pendingCount(): number;
};

const closedError = (action: ActionType, detail: string): GMConnectionClosedError =>
  new GMConnectionClosedError({
    action: actionName(action),
    message: `The Google Messages connection closed (${detail}) before the phone answered ${actionName(action)}. A send may still be delivered; check the conversation before retrying.`,
  });

const authExpiredError = (status: number): GMAuthExpiredError =>
  new GMAuthExpiredError({
    reason: "pollingRejected",
    status,
    message: `Google rejected this Messages for web session (HTTP ${status} on the long poll), so the phone is no longer paired with it. Stored messages are intact; pair the phone again to continue.`,
  });

const createSessionHandler = (deps: { readonly http: HttpContext; readonly timing: SessionTiming }): SessionHandler => {
  const { http, timing } = deps;
  const { authData, logger, clock } = http;
  const waiters = new Map<string, Waiter>();
  let ackQueue: string[] = [];
  let ackTimer: TimerHandle | null = null;
  let ackRunning = false;
  // libgm leaves sessionID empty until SetActiveSession, so pairing requests carry "".
  let sessionId = "";

  const payloadError = (w: Waiter): GMNoResponsePayloadError => {
    const waitedMs = clock.now().getTime() - w.sentAt;
    const name = actionName(w.action);
    return new GMNoResponsePayloadError({
      action: name,
      frames: w.skipped,
      accountSwitch: w.accountSwitch,
      waitedMs,
      message: w.accountSwitch
        ? `The phone answered ${name} without its data and sent a Google-account switch notice instead; it may have been paired with a Google account elsewhere. Re-pair this session if it keeps happening.`
        : `The phone answered ${name} ${w.skipped} time(s) without the requested data within ${Math.round(waitedMs / 1000)} s. Nothing was changed; try again.`,
    });
  };

  const phoneNotResponding = (action: ActionType, waitedMs: number): GMPhoneNotRespondingError =>
    new GMPhoneNotRespondingError({
      action: actionName(action),
      waitedMs,
      message: `The phone did not answer ${actionName(action)} within ${Math.round(waitedMs / 1000)} s; it may be offline or asleep without a connection. Google accepted the request, so a send may still be delivered when the phone comes back: check before resending.`,
    });

  const clearGrace = (w: Waiter): void => {
    if (w.graceTimer !== null) {
      clock.clearTimeout(w.graceTimer);
      w.graceTimer = null;
    }
  };

  const register = (requestId: string, action: ActionType): Waiter => {
    const old = waiters.get(requestId);
    if (old !== undefined) {
      // Request ids are random UUIDs; this only guards against misuse.
      waiters.delete(requestId);
      clearGrace(old);
      old.settle({ kind: "failed", error: closedError(old.action, "its request id was reused") });
      logger.warn("request id reused while its earlier request was still waiting", { action: actionName(old.action) });
    }
    let resolve: (outcome: Terminal) => void = () => {};
    const done = new Promise<Terminal>((r) => {
      resolve = r;
    });
    const waiter: Waiter = {
      action,
      sentAt: clock.now().getTime(),
      skipped: 0,
      lastShape: null,
      accountSwitch: false,
      graceTimer: null,
      settled: false,
      done,
      settle: (outcome) => {
        if (waiter.settled) return;
        waiter.settled = true;
        resolve(outcome);
      },
    };
    waiters.set(requestId, waiter);
    return waiter;
  };

  /** Removes the waiter if it is still registered; returns whether it was. */
  const unregister = (requestId: string, waiter: Waiter): boolean => {
    if (waiters.get(requestId) !== waiter) return false;
    waiters.delete(requestId);
    clearGrace(waiter);
    return true;
  };

  const postRpc = async (requestId: string, params: SendParams): Promise<Result<void, GMTransportError>> => {
    const { message } = buildMessage(authData, sessionId, { ...params, requestId });
    const res = await GMHttp.request(http, {
      url: sendUrl(authData),
      action: actionName(params.action),
      contentType: CONTENT_TYPE_PBLITE,
      requestSchema: OutgoingRPCMessageSchema,
      message,
      responseSchema: OutgoingRPCResponseSchema,
    });
    return res.isErr() ? Result.err(res.error) : Result.ok();
  };

  const newRequestId = (params: SendParams): string =>
    params.requestId === undefined || params.requestId === "" ? randomUUID() : params.requestId;

  const pending = (requestId: string, waiter: Waiter): PendingRequest => ({
    requestId,
    action: waiter.action,
    wait: ({ timeoutMs, signal }) =>
      new Promise<WaitOutcome>((resolve) => {
        let timer: TimerHandle | null = null;
        const cleanup = (): void => {
          if (timer !== null) clock.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          if (unregister(requestId, waiter)) {
            waiter.settle({ kind: "failed", error: closedError(waiter.action, "the caller stopped waiting") });
            resolve({ kind: "aborted" });
          }
        };
        void waiter.done.then((outcome) => {
          cleanup();
          resolve(outcome);
        });
        if (timeoutMs !== null) {
          timer = clock.setTimeout(() => {
            cleanup();
            if (!unregister(requestId, waiter)) return; // settled meanwhile; `done` resolves us
            const error = waiter.skipped > 0 ? payloadError(waiter) : phoneNotResponding(waiter.action, timeoutMs);
            logger.warn("phone did not answer in time; giving up on the request", {
              action: actionName(waiter.action),
              timeoutMs,
              payloadlessFrames: waiter.skipped,
            });
            waiter.settle({ kind: "failed", error: closedError(waiter.action, "timed out") });
            resolve({ kind: "timeout", error });
          }, timeoutMs);
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });

  const sendAsync = async (params: SendParams): Promise<Result<PendingRequest, GMTransportError>> => {
    const requestId = newRequestId(params);
    const waiter = register(requestId, params.action);
    logger.debug("sending request to phone", { action: actionName(params.action) });
    const sent = await postRpc(requestId, params);
    if (sent.isErr()) {
      if (unregister(requestId, waiter)) {
        waiter.settle({ kind: "failed", error: closedError(waiter.action, "the request was not sent") });
      }
      return Result.err(sent.error);
    }
    return Result.ok(pending(requestId, waiter));
  };

  const sendAcks = async (): Promise<void> => {
    const ids = ackQueue;
    ackQueue = [];
    if (ids.length === 0) return;
    const res = await GMHttp.request(http, {
      url: ackUrl(authData),
      action: "acknowledging messages",
      contentType: CONTENT_TYPE_PBLITE,
      requestSchema: AckMessageRequestSchema,
      message: buildAckRequest(authData, randomUUID(), ids),
      responseSchema: OutgoingRPCResponseSchema,
    });
    if (res.isErr()) {
      // libgm does not retry either; Google redelivers unacked messages.
      logger.warn("failed to send acks", { count: ids.length, error: res.error._tag, status: "status" in res.error ? res.error.status : null });
    } else {
      logger.debug("sent acks", { count: ids.length });
    }
  };
  let flushing: Promise<void> = Promise.resolve();

  const handler: SessionHandler = {
    sessionId: () => sessionId,

    resetSessionId() {
      sessionId = randomUUID();
      return sessionId;
    },

    async sendNoResponse(params) {
      logger.debug("sending request to phone (no response expected)", { action: actionName(params.action) });
      return postRpc(newRequestId(params), params);
    },

    sendAsync,

    async send(params) {
      const sent = await sendAsync(params);
      if (sent.isErr()) return Result.err(sent.error);
      const outcome = await sent.value.wait({ timeoutMs: timing.requestTimeoutMs });
      switch (outcome.kind) {
        case "response":
          return Result.ok(outcome.rpc);
        case "failed":
        case "timeout":
          return Result.err(outcome.error);
        case "aborted":
          return Result.err(closedError(params.action, "the caller stopped waiting"));
      }
    },

    receiveResponse(rpc) {
      if (rpc.route !== "data") return false;
      const requestId = rpc.data.sessionID;
      if (AuthData.hasCookies(authData)) {
        const exempt =
          rpc.data.action === ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT ||
          rpc.data.action === ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED;
        // libgm: ignore unencrypted-only frames that arrive before real responses.
        if (!exempt && rpc.shape.hasUnencrypted && !rpc.shape.hasPayload) {
          const w = waiters.get(requestId);
          if (w !== undefined && PAYLOAD_REQUIRED.has(w.action)) {
            logger.info("ignoring unencrypted intermediate frame for pending request", IncomingRpc.shapeFields(rpc.shape));
          }
          return false;
        }
      }
      const w = waiters.get(requestId);
      if (w === undefined) {
        if (rpc.data.action !== ActionType.GET_UPDATES) {
          const fields = IncomingRpc.shapeFields(rpc.shape);
          if (rpc.data.action === ActionType.NOTIFY_DITTO_ACTIVITY) logger.debug("received response with no pending request", fields);
          else logger.info("received response with no pending request", fields);
        }
        return false;
      }
      if (rejectsPayloadless(w.action, rpc.shape)) {
        w.skipped++;
        w.lastShape = rpc.shape;
        w.accountSwitch = w.accountSwitch || rpc.shape.accountSwitch;
        if (w.graceTimer === null) {
          w.graceTimer = clock.setTimeout(() => {
            w.graceTimer = null;
            if (!unregister(requestId, w)) return;
            const error = payloadError(w);
            logger.warn("phone never sent a response payload; failing the request", {
              action: actionName(w.action),
              payloadlessFrames: w.skipped,
              accountSwitch: w.accountSwitch,
            });
            w.settle({ kind: "failed", error });
          }, timing.payloadGraceMs);
        }
        logger.warn("phone answered a pending request without a response payload; waiting for the real response", {
          ...IncomingRpc.shapeFields(rpc.shape),
          payloadlessFrames: w.skipped,
        });
        return true;
      }
      unregister(requestId, w);
      logger.debug("received response", {
        action: actionName(w.action),
        elapsedMs: clock.now().getTime() - w.sentAt,
        payloadlessFramesBefore: w.skipped,
      });
      w.settle({ kind: "response", rpc });
      return true;
    },

    queueAck(responseId) {
      if (!ackQueue.includes(responseId)) ackQueue.push(responseId);
    },

    flushAcks() {
      // Serialized, so close() also waits for a flush the interval started.
      const next = flushing.then(sendAcks);
      flushing = next;
      return next;
    },

    startAckInterval() {
      if (ackRunning) return;
      ackRunning = true;
      const arm = (): void => {
        ackTimer = clock.setTimeout(() => {
          ackTimer = null;
          void handler.flushAcks().then(() => {
            if (ackRunning) arm();
          });
        }, timing.ackIntervalMs);
      };
      arm();
    },

    stopAckInterval() {
      ackRunning = false;
      if (ackTimer !== null) {
        clock.clearTimeout(ackTimer);
        ackTimer = null;
      }
    },

    failPending(reason) {
      const entries = [...waiters.entries()];
      for (const [requestId, w] of entries) {
        unregister(requestId, w);
        w.settle({
          kind: "failed",
          error: reason.kind === "closed" ? closedError(w.action, reason.detail) : authExpiredError(reason.status),
        });
      }
      return entries.length;
    },

    pendingCount: () => waiters.size,
  };
  return handler;
};

export const SessionHandler = {
  create: createSessionHandler,
  buildMessage,
  buildAckRequest,
  rejectsPayloadless,
  sendUrl,
  ackUrl,
} as const;

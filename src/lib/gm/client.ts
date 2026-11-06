import { randomUUID } from "node:crypto";
import { create, isMessage, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { Result } from "better-result";

import {
  RegisterRefreshRequestSchema,
  RegisterRefreshResponseSchema,
  RevokeGaiaPairingRequestSchema,
  RevokeRelayPairingRequestSchema,
  RevokeRelayPairingResponseSchema,
  type PairedData,
  type RegisterRefreshRequest,
  type RevokeRelayPairingRequest,
} from "@/gen/gmproto/authentication_pb";
import {
  GetConversationRequestSchema,
  GetConversationResponseSchema,
  GetOrCreateConversationRequestSchema,
  GetOrCreateConversationResponseSchema,
  ListContactsRequestSchema,
  ListContactsResponseSchema,
  ListConversationsRequestSchema,
  ListConversationsResponseSchema,
  ListMessagesRequestSchema,
  ListMessagesResponseSchema,
  ListTopContactsRequestSchema,
  ListTopContactsResponseSchema,
  MessageReadRequestSchema,
  ReceiveMessagesRequestSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  SendReactionRequestSchema,
  SendReactionResponseSchema,
  type Cursor,
  type GetOrCreateConversationRequest,
  type GetOrCreateConversationResponse,
  type ListContactsResponse,
  type ListConversationsRequest_Folder,
  type ListConversationsResponse,
  type ListMessagesResponse,
  type ListTopContactsResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SendReactionRequest,
  type SendReactionResponse,
} from "@/gen/gmproto/client_pb";
import type { Conversation } from "@/gen/gmproto/conversations_pb";
import type { RPCPairData } from "@/gen/gmproto/events_pb";
import { ActionType, MessageType, type IncomingRPCMessage } from "@/gen/gmproto/rpc_pb";

import { AuthData, NIL_UUID } from "./auth-data";
import { Clock } from "./clock";
import {
  configVersion,
  CONTENT_TYPE_PBLITE,
  CONTENT_TYPE_PROTOBUF,
  REGISTER_REFRESH_URL,
  REVOKE_RELAY_PAIRING_URL,
} from "./constants";
import { Jwk } from "./crypto/jwk";
import {
  GMAbortedError,
  GMAuthExpiredError,
  GMConnectionClosedError,
  GMDecodeError,
  GMHttpError,
  GMNotConnectedError,
  GMNotLoggedInError,
  type GMConnectError,
  type GMRpcError,
  type GMTransportError,
} from "./errors";
import { actionName, IncomingRpc, type DataRpc, type GMEvent } from "./events";
import { GMHttp, type FetchFn, type HttpContext } from "./http";
import { GMLogger } from "./logger";
import { LongPoll, type LongPollFrame } from "./longpoll";
import { Pblite } from "./pblite";
import {
  DEFAULT_ACK_INTERVAL_MS,
  DEFAULT_PAYLOAD_GRACE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SessionHandler,
  type SendParams,
} from "./session";

export type { GMEvent } from "./events";

// libgm client.go, longpoll.go (doLongPoll), event_handler.go (HandleRPCMsg)
// and methods.go, reshaped for one serverless invocation: connect once, issue
// RPCs, close. There is no ditto pinger; an unanswered RPC fails with
// GMPhoneNotRespondingError after the request timeout.

/** Timing knobs. Production uses the defaults; tests shorten them. */
export type GMTiming = {
  /** Per-RPC wait for the phone's answer (libgm SetRequestTimeout). */
  readonly requestTimeoutMs: number;
  /** Extra wait after a payload-less answer (libgm DefaultResponsePayloadGrace). */
  readonly payloadGraceMs: number;
  readonly ackIntervalMs: number;
  /** connect(): wait for the startup ack-count frame and its backlog (libgm postConnect sleeps 2 s). */
  readonly startupAckWaitMs: number;
  /** connect(): extra wait while backlog frames are still due (libgm waits up to 3 x 1 s). */
  readonly startupBacklogExtraMs: number;
  /** connect(): pause between the startup acks and SetActiveSession (libgm sleeps 1 s). */
  readonly postAckDelayMs: number;
  /** Delays before successive long-poll reconnect attempts; the poll gives up after the last one. */
  readonly reconnectBackoffMs: readonly number[];
  /** Attempts to open the first long poll before connect() fails. */
  readonly firstOpenAttempts: number;
  readonly pollHeadersTimeoutMs: number;
};

export const DEFAULT_TIMING: GMTiming = {
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  payloadGraceMs: DEFAULT_PAYLOAD_GRACE_MS,
  ackIntervalMs: DEFAULT_ACK_INTERVAL_MS,
  startupAckWaitMs: 2_000,
  startupBacklogExtraMs: 3_000,
  postAckDelayMs: 300,
  reconnectBackoffMs: [500, 1_000, 2_000, 4_000, 5_000],
  firstOpenAttempts: 2,
  pollHeadersTimeoutMs: 20_000,
};

// ---- Request builders (exported for parity tests) ----

const encrypted = <Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): SendParams["payload"] => ({
  kind: "encrypted",
  bytes: toBinary(schema, message),
});

export const GMRequests = {
  /** libgm SetActiveSession: GET_UPDATES with the new session id as request id, no TTL. */
  setActiveSession: (sessionId: string): SendParams => ({ action: ActionType.GET_UPDATES, ttl: "omit", requestId: sessionId }),

  /** libgm ListConversationsWithCursor; the first call per client is a BUGLE_ANNOTATION. */
  listConversations: (
    req: { readonly count: number; readonly folder: ListConversationsRequest_Folder; readonly cursor?: Cursor },
    first: boolean,
  ): SendParams => ({
    action: ActionType.LIST_CONVERSATIONS,
    payload: encrypted(
      ListConversationsRequestSchema,
      create(ListConversationsRequestSchema, { count: BigInt(req.count), folder: req.folder, cursor: req.cursor }),
    ),
    messageType: first ? MessageType.BUGLE_ANNOTATION : MessageType.BUGLE_MESSAGE,
  }),

  fetchMessages: (req: { readonly conversationId: string; readonly count: number; readonly cursor?: Cursor }): SendParams => ({
    action: ActionType.LIST_MESSAGES,
    payload: encrypted(
      ListMessagesRequestSchema,
      create(ListMessagesRequestSchema, { conversationID: req.conversationId, count: BigInt(req.count), cursor: req.cursor }),
    ),
  }),

  getConversation: (conversationId: string): SendParams => ({
    action: ActionType.GET_CONVERSATION,
    payload: encrypted(GetConversationRequestSchema, create(GetConversationRequestSchema, { conversationID: conversationId })),
  }),

  getOrCreateConversation: (req: GetOrCreateConversationRequest): SendParams => ({
    action: ActionType.GET_OR_CREATE_CONVERSATION,
    payload: encrypted(GetOrCreateConversationRequestSchema, req),
  }),

  sendMessage: (req: SendMessageRequest): SendParams => ({
    action: ActionType.SEND_MESSAGE,
    payload: encrypted(SendMessageRequestSchema, req),
  }),

  sendReaction: (req: SendReactionRequest): SendParams => ({
    action: ActionType.SEND_REACTION,
    payload: encrypted(SendReactionRequestSchema, req),
  }),

  markRead: (conversationId: string, messageId: string): SendParams => ({
    action: ActionType.MESSAGE_READ,
    payload: encrypted(
      MessageReadRequestSchema,
      create(MessageReadRequestSchema, { conversationID: conversationId, messageID: messageId }),
    ),
  }),

  listContacts: (): SendParams => ({
    action: ActionType.LIST_CONTACTS,
    payload: encrypted(ListContactsRequestSchema, create(ListContactsRequestSchema, { i1: 1, i2: 350, i3: 50 })),
  }),

  listTopContacts: (): SendParams => ({
    action: ActionType.LIST_TOP_CONTACTS,
    payload: encrypted(ListTopContactsRequestSchema, create(ListTopContactsRequestSchema, { count: 8 })),
  }),

  ackBrowserPresence: (): SendParams => ({ action: ActionType.ACK_BROWSER_PRESENCE }),

  unpairGaia: (pairingId: string | null): SendParams => ({
    action: ActionType.UNPAIR_GAIA_PAIRING,
    payload: encrypted(
      RevokeGaiaPairingRequestSchema,
      create(RevokeGaiaPairingRequestSchema, { pairingAttemptID: pairingId ?? NIL_UUID }),
    ),
  }),

  /** libgm refreshAuthToken's RegisterRefreshRequest (no push keys). */
  registerRefresh: (
    authData: AuthData,
    sig: { readonly requestId: string; readonly timestampMicros: bigint; readonly signature: Uint8Array },
  ): RegisterRefreshRequest =>
    create(RegisterRefreshRequestSchema, {
      messageAuth: {
        requestID: sig.requestId,
        tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
        network: AuthData.authNetwork(authData),
        configVersion: configVersion(),
      },
      currBrowserDevice: authData.browser ?? undefined,
      unixTimestamp: sig.timestampMicros,
      signature: sig.signature,
      parameters: { emptyArr: {} },
      messageType: 2,
    }),

  /** libgm UnpairBugle's RevokeRelayPairingRequest. */
  revokeRelayPairing: (authData: AuthData, requestId: string): RevokeRelayPairingRequest =>
    create(RevokeRelayPairingRequestSchema, {
      authMessage: {
        requestID: requestId,
        tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
        configVersion: configVersion(),
      },
      browser: authData.browser ?? undefined,
    }),
} as const;

// ---- Connection engine (shared by GMClient and the pairing flows) ----

export type StopReason =
  | { readonly kind: "closed" }
  | { readonly kind: "authExpired"; readonly error: GMAuthExpiredError }
  | { readonly kind: "gaveUp"; readonly error: GMConnectError };

export type ConnectionMode =
  /** A paired session: refreshes the token, emits listen events, treats 401/403 as fatal. */
  | { readonly kind: "client" }
  /** Pairing (libgm doLongPoll with loggedIn=false). `onPair` receives QR PairEvent Paired data. */
  | { readonly kind: "pairing"; readonly onPair?: (paired: PairedData) => void };

export type ConnectionDeps = {
  readonly authData: AuthData;
  readonly fetch: FetchFn;
  readonly logger: GMLogger;
  readonly clock: Clock;
  readonly timing: GMTiming;
  readonly mode: ConnectionMode;
  readonly emit: (event: GMEvent) => void;
};

export type GMConnection = {
  readonly authData: AuthData;
  readonly http: HttpContext;
  readonly session: SessionHandler;
  readonly logger: GMLogger;
  readonly clock: Clock;
  readonly timing: GMTiming;
  /** Starts the long-poll loop (once). Resolves when the first stream answered 2xx, or with the error that stopped it. */
  openLongPoll(signal?: AbortSignal): Promise<Result<void, GMConnectError>>;
  /** libgm refreshAuthToken: only when a browser is set and the token expires within 1 h. */
  refreshTokenIfNeeded(signal?: AbortSignal): Promise<Result<void, GMTransportError | GMAuthExpiredError>>;
  /** Waits (bounded) for the startup ack-count frame and the backlog it announces. */
  awaitStartupBacklog(signal?: AbortSignal): Promise<void>;
  readonly stopReason: () => StopReason | null;
  /** Clock time (ms) of the last data frame, or of creation. */
  readonly lastDataAt: () => number;
  /** Registers a listener called once when the connection stops; returns an unsubscribe function. */
  onStopped(listener: (reason: StopReason) => void): () => void;
  /** Keeps a background task so close() can wait for it. */
  track(task: Promise<unknown>): void;
  /** Stops the long poll, fails pending requests, waits for background work, flushes acks. Idempotent. */
  close(): Promise<void>;
};

const isAuthStatus = (status: number): boolean => status === 401 || status === 403;

/** A 4xx refusal of the refresh itself; 408 and 429 are transient (the session is still valid). */
const isRefreshRejection = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

const pollAuthExpired = (status: number): GMAuthExpiredError =>
  new GMAuthExpiredError({
    reason: "pollingRejected",
    status,
    message: `Google rejected this Messages for web session (HTTP ${status} on the long poll), so the phone is no longer paired with it. Stored messages are intact; pair the phone again to continue.`,
  });

const refreshRejected = (status: number): GMAuthExpiredError =>
  new GMAuthExpiredError({
    reason: "refreshRejected",
    status,
    message: `Google refused to refresh this Messages for web session's token (HTTP ${status}); the pairing was revoked or expired. Stored messages are intact; pair the phone again to continue.`,
  });

export const createConnection = (deps: ConnectionDeps): GMConnection => {
  const { authData, logger, clock, timing, mode } = deps;
  const isClient = mode.kind === "client";
  const emit = (event: GMEvent): void => {
    if (!isClient) return;
    try {
      deps.emit(event);
    } catch (cause) {
      logger.error("onEvent handler threw; continuing", { event: event.type, error: cause instanceof Error ? cause.name : "unknown" });
    }
  };
  const http: HttpContext = {
    fetch: deps.fetch,
    authData,
    logger,
    clock,
    onCookiesChanged: () => emit({ type: "authDataChanged" }),
  };
  const session = SessionHandler.create({ http, timing });
  const stop = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const progressListeners = new Set<() => void>();
  const stopListeners = new Set<(reason: StopReason) => void>();
  let stopReason: StopReason | null = null;
  let loop: Promise<void> | null = null;
  let firstOpen: Promise<Result<void, GMConnectError>> | null = null;
  let closing: Promise<void> | null = null;
  let skipCount = 0;
  let ackSeen = false;
  let lastDataAt = clock.now().getTime();

  const notifyProgress = (): void => {
    for (const listener of [...progressListeners]) listener();
  };

  const track = (task: Promise<unknown>): void => {
    const settled = task.then(
      () => {},
      () => {},
    );
    tasks.add(settled);
    void settled.then(() => tasks.delete(settled));
  };

  const setStopped = (reason: StopReason): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    stop.abort();
    notifyProgress();
    for (const listener of [...stopListeners]) listener(reason);
    stopListeners.clear();
  };

  const handlePair = (pair: RPCPairData): void => {
    const event = pair.event;
    if (event.case === "paired") {
      const tokenData = event.value.tokenData;
      AuthData.applyTokenData(
        authData,
        tokenData?.tachyonAuthToken ?? new Uint8Array(0),
        tokenData?.TTL ?? 0n,
        clock.now(),
      );
      authData.mobile = event.value.mobile ?? null;
      authData.browser = event.value.browser ?? null;
      logger.info("phone paired");
      if (mode.kind === "pairing") mode.onPair?.(event.value);
    } else if (event.case === "revoked") {
      logger.warn("phone revoked the pairing");
    } else {
      logger.debug("unknown pair event");
    }
  };

  /** libgm HandleRPCMsg. */
  const handleRpc = (raw: IncomingRPCMessage): void => {
    lastDataAt = clock.now().getTime();
    const decoded = IncomingRpc.decode(raw, authData.requestCrypto);
    if (decoded.isErr()) {
      logger.error("failed to decode incoming RPC message", { responseId: raw.responseID, error: decoded.error.message });
      session.queueAck(raw.responseID);
      return;
    }
    const { rpc, accountChange } = decoded.value;
    if (accountChange !== null) emit({ type: "accountChange", account: accountChange.account, isFake: true });
    session.queueAck(raw.responseID);
    if (!session.receiveResponse(rpc)) {
      if (rpc.route === "pair") handlePair(rpc.pair);
      else if (rpc.route === "gaia") logger.debug("gaia event");
      else {
        let isOld = false;
        if (skipCount > 0) {
          skipCount--;
          isOld = true;
        }
        for (const effect of IncomingRpc.routeUpdate(rpc, isOld, dedup, logger)) {
          if (effect.kind === "event") emit(effect.event);
          else ackBrowserPresence();
        }
      }
    }
    notifyProgress();
  };

  const dedup = IncomingRpc.createDedup();

  const ackBrowserPresence = (): void => {
    track(
      session.sendNoResponse(GMRequests.ackBrowserPresence()).then((res) => {
        if (res.isErr()) logger.warn("failed to ack browser presence", { error: res.error._tag });
      }),
    );
  };

  const onFrame = (frame: LongPollFrame): void => {
    switch (frame.kind) {
      case "data":
        handleRpc(frame.message);
        return;
      case "ack":
        logger.debug("got startup ack count", { count: frame.count });
        skipCount = frame.count;
        ackSeen = true;
        notifyProgress();
        return;
      case "startRead":
      case "heartbeat":
        return;
      case "unknown":
        logger.warn("got unknown long poll frame");
        return;
      case "invalid":
        logger.error("could not decode long poll frame", { error: frame.error.message });
        return;
    }
  };

  const refreshTokenIfNeeded = async (signal?: AbortSignal): Promise<Result<void, GMTransportError | GMAuthExpiredError>> => {
    if (authData.browser === null || !AuthData.needsTokenRefresh(authData, clock.now())) return Result.ok();
    const requestId = randomUUID();
    const timestampMicros = BigInt(clock.now().getTime()) * 1000n;
    const signature = Jwk.signRequest(authData.refreshKey, requestId, timestampMicros);
    logger.debug("refreshing tachyon token");
    const res = await GMHttp.request(http, {
      url: REGISTER_REFRESH_URL,
      action: "refreshing token",
      contentType: CONTENT_TYPE_PBLITE,
      requestSchema: RegisterRefreshRequestSchema,
      message: GMRequests.registerRefresh(authData, { requestId, timestampMicros, signature }),
      responseSchema: RegisterRefreshResponseSchema,
      // close() also stops it, so no refresh rewrites the token after close() returned.
      signal: signal === undefined || signal === stop.signal ? stop.signal : AbortSignal.any([signal, stop.signal]),
    });
    if (res.isErr()) {
      const error = res.error;
      if ((error._tag === "GMHttpError" || error._tag === "GMRequestError") && isRefreshRejection(error.status)) {
        return Result.err(refreshRejected(error.status));
      }
      return Result.err(error);
    }
    const token = res.value.tokenData?.tachyonAuthToken ?? new Uint8Array(0);
    if (token.length === 0) {
      return Result.err(
        new GMDecodeError({
          action: "refreshing token",
          message:
            "Google answered the token refresh without a token; the session was not changed. Try again; re-pair if it keeps happening.",
        }),
      );
    }
    AuthData.applyTokenData(authData, token, res.value.tokenData?.TTL ?? 0n, clock.now());
    logger.debug("refreshed tachyon token", { expiresAt: authData.tachyonExpiry?.toISOString() ?? null });
    emit({ type: "authDataChanged" });
    return Result.ok();
  };

  /** libgm doLongPoll, with bounded reconnect backoff. */
  const runLoop = async (settleFirst: (r: Result<void, GMConnectError>) => void): Promise<void> => {
    const listenRequestId = randomUUID();
    let failures = 0;
    let everOpened = false;

    const failed = async (error: GMConnectError): Promise<"retry" | "stop"> => {
      failures++;
      emit({ type: "listenTemporary", message: error.message });
      const limit = everOpened ? timing.reconnectBackoffMs.length : Math.max(0, timing.firstOpenAttempts - 1);
      if (failures > limit) {
        logger.error("long poll could not reconnect; giving up", { failures, error: error._tag });
        setStopped({ kind: "gaveUp", error });
        session.failPending({ kind: "closed", detail: "the long poll could not reconnect" });
        settleFirst(Result.err(error));
        return "stop";
      }
      const delay = timing.reconnectBackoffMs[Math.min(failures - 1, timing.reconnectBackoffMs.length - 1)] ?? 1_000;
      logger.warn("long poll failed; retrying", { failures, delayMs: delay, error: error._tag });
      return (await Clock.sleep(clock, delay, stop.signal)) === "slept" ? "retry" : "stop";
    };

    const fatal = (status: number): void => {
      const error = GMHttp.httpError(status, "polling");
      logger.error("long poll rejected the session", { status });
      emit({ type: "listenFatal", error });
      const expired = pollAuthExpired(status);
      setStopped({ kind: "authExpired", error: expired });
      session.failPending({ kind: "authExpired", status });
      settleFirst(Result.err(expired));
    };

    while (stopReason === null) {
      if (isClient) {
        const refreshed = await refreshTokenIfNeeded(stop.signal);
        if (refreshed.isErr()) {
          const error = refreshed.error;
          if (error._tag === "GMAbortedError") break;
          if (error._tag === "GMAuthExpiredError") {
            emit({ type: "listenFatal", error: GMHttp.httpError(error.status ?? 401, "refreshing token") });
            setStopped({ kind: "authExpired", error });
            session.failPending({ kind: "authExpired", status: error.status ?? 401 });
            settleFirst(Result.err(error));
            return;
          }
          if ((await failed(error)) === "stop") break;
          continue;
        }
      }
      const opened = await GMHttp.openStream(http, {
        url: LongPoll.url(authData),
        action: "polling",
        contentType: CONTENT_TYPE_PBLITE,
        body: Pblite.marshal(ReceiveMessagesRequestSchema, LongPoll.buildRequest(authData, listenRequestId)),
        signal: stop.signal,
        headersTimeoutMs: timing.pollHeadersTimeoutMs,
      });
      if (opened.isErr()) {
        if (opened.error._tag === "GMAbortedError") break;
        if ((await failed(opened.error)) === "stop") break;
        continue;
      }
      const { response, abort } = opened.value;
      if (isAuthStatus(response.status)) {
        await response.arrayBuffer().catch(() => undefined);
        abort();
        fatal(response.status);
        return;
      }
      if (response.status >= 400 || response.body === null) {
        await response.arrayBuffer().catch(() => undefined);
        abort();
        if ((await failed(GMHttp.httpError(response.status, "polling"))) === "stop") break;
        continue;
      }
      everOpened = true;
      failures = 0;
      logger.debug("long poll opened", { status: response.status });
      settleFirst(Result.ok());
      const outcome = await LongPoll.consume(
        response.body,
        { onOpened: () => logger.debug("long poll stream started"), onFrame, logger },
        stop.signal,
      );
      abort();
      if (stopReason !== null) break;
      if (outcome.kind === "malformed") {
        logger.warn("long poll stream was malformed", { error: outcome.error.message });
        if ((await failed(new GMDecodeError({ action: "polling", message: outcome.error.message }))) === "stop") break;
        continue;
      }
      if (!outcome.opened) {
        const error =
          outcome.kind === "readError"
            ? new GMDecodeError({ action: "polling", message: "The long poll stream broke before it started; it will be reopened.", cause: outcome.cause })
            : new GMDecodeError({ action: "polling", message: "The long poll stream ended before it started; it will be reopened." });
        if ((await failed(error)) === "stop") break;
        continue;
      }
      logger.debug("long poll stream ended; reconnecting", { frames: outcome.frames, cleanEnd: outcome.kind === "eof" && outcome.ended });
    }
    settleFirst(
      Result.err(
        new GMConnectionClosedError({
          action: "polling",
          message: "The Google Messages connection was closed before the long poll opened.",
        }),
      ),
    );
  };

  const openLongPoll = (signal?: AbortSignal): Promise<Result<void, GMConnectError>> => {
    if (firstOpen === null) {
      let settle: (r: Result<void, GMConnectError>) => void = () => {};
      let settled = false;
      firstOpen = new Promise((resolve) => {
        settle = (r) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
      });
      loop = runLoop(settle).catch((cause: unknown) => {
        logger.error("long poll loop crashed", { error: cause instanceof Error ? cause.name : "unknown" });
        const error = new GMConnectionClosedError({ action: "polling", message: "The Google Messages long poll stopped unexpectedly; reconnect to continue." });
        setStopped({ kind: "gaveUp", error });
        session.failPending({ kind: "closed", detail: "the long poll stopped unexpectedly" });
        settle(Result.err(error));
      });
    }
    const first = firstOpen;
    if (signal === undefined) return first;
    if (signal.aborted) return Promise.resolve(Result.err(aborted("opening the long poll")));
    return new Promise((resolve) => {
      const onAbort = (): void => resolve(Result.err(aborted("opening the long poll")));
      signal.addEventListener("abort", onAbort, { once: true });
      void first.then((r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
    });
  };

  /** Resolves when `done()` holds, `ms` passes, the connection stops, or `signal` aborts. */
  const waitFor = (done: () => boolean, ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (done() || stopReason !== null || signal?.aborted || ms <= 0) {
        resolve();
        return;
      }
      const finish = (): void => {
        clock.clearTimeout(timer);
        progressListeners.delete(check);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const check = (): void => {
        if (done() || stopReason !== null) finish();
      };
      const timer = clock.setTimeout(finish, ms);
      progressListeners.add(check);
      signal?.addEventListener("abort", finish, { once: true });
    });

  const awaitStartupBacklog = async (signal?: AbortSignal): Promise<void> => {
    await waitFor(() => ackSeen && skipCount === 0, timing.startupAckWaitMs, signal);
    if (skipCount > 0) {
      logger.warn("startup backlog still arriving; waiting longer", { skipCount });
      await waitFor(() => skipCount === 0, timing.startupBacklogExtraMs, signal);
      if (skipCount > 0) logger.warn("startup backlog did not finish; continuing", { skipCount });
    } else if (!ackSeen) {
      logger.debug("no startup ack count frame arrived; continuing");
    }
  };

  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      const expired = stopReason?.kind === "authExpired";
      setStopped({ kind: "closed" });
      session.stopAckInterval();
      const failedCount = session.failPending({ kind: "closed", detail: "the client was closed" });
      if (failedCount > 0) logger.debug("failed pending requests on close", { count: failedCount });
      if (loop !== null) await loop;
      while (tasks.size > 0) await Promise.all([...tasks]);
      if (!expired) await session.flushAcks();
      progressListeners.clear();
    })();
    return closing;
  };

  return {
    authData,
    http,
    session,
    logger,
    clock,
    timing,
    openLongPoll,
    refreshTokenIfNeeded,
    awaitStartupBacklog,
    stopReason: () => stopReason,
    lastDataAt: () => lastDataAt,
    onStopped(listener) {
      if (stopReason !== null) {
        listener(stopReason);
        return () => {};
      }
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    track,
    close,
  };
};

const aborted = (action: string): GMAbortedError =>
  new GMAbortedError({ action, message: `Stopped ${action} because the caller cancelled the operation.` });

// ---- GMClient ----

export type GMClientOptions = {
  /** The client mutates this object in place. */
  authData: AuthData;
  /** Injectable for tests. */
  fetch?: FetchFn;
  /** Per RPC, default 30_000. */
  requestTimeoutMs?: number;
  onEvent?: (event: GMEvent) => void;
  logger?: GMLogger;
  /** Test-only overrides of timing and the clock. */
  testing?: { readonly timing?: Partial<GMTiming>; readonly clock?: Clock };
};

export type GMClient = {
  readonly authData: AuthData;
  /** Refresh the tachyon token if it expires within 1h, open the long poll,
   *  ack startup backlog, set the active session (GET_UPDATES). Resolves once
   *  RPCs can be sent. */
  connect(opts?: { signal?: AbortSignal }): Promise<Result<void, GMConnectError>>;
  /** Flush pending acks, close the long poll, fail pending requests. Idempotent. */
  close(): Promise<void>;
  /** Resolve after `quietMs` with no incoming data events (or `maxMs`). */
  waitForQuiet(opts: { quietMs: number; maxMs: number }): Promise<void>;

  listConversations(req: { count: number; folder: ListConversationsRequest_Folder; cursor?: Cursor }): Promise<Result<ListConversationsResponse, GMRpcError>>;
  fetchMessages(req: { conversationId: string; count: number; cursor?: Cursor }): Promise<Result<ListMessagesResponse, GMRpcError>>;
  getConversation(conversationId: string): Promise<Result<Conversation, GMRpcError>>;
  getOrCreateConversation(req: GetOrCreateConversationRequest): Promise<Result<GetOrCreateConversationResponse, GMRpcError>>;
  sendMessage(req: SendMessageRequest): Promise<Result<SendMessageResponse, GMRpcError>>;
  sendReaction(req: SendReactionRequest): Promise<Result<SendReactionResponse, GMRpcError>>;
  markRead(conversationId: string, messageId: string): Promise<Result<void, GMRpcError>>;
  listContacts(): Promise<Result<ListContactsResponse, GMRpcError>>;
  listTopContacts(): Promise<Result<ListTopContactsResponse, GMRpcError>>;
  /** Best-effort unpair (Gaia: UNPAIR_GAIA_PAIRING; QR: RevokeRelayPairing). */
  unpair(): Promise<Result<void, GMRpcError | GMHttpError>>;
};

type ClientState = "idle" | "connecting" | "ready" | "failed" | "closed";

const createClient = (opts: GMClientOptions): GMClient => {
  const authData = opts.authData;
  const logger = opts.logger ?? GMLogger.noop;
  const clock = opts.testing?.clock ?? Clock.real;
  const timing: GMTiming = {
    ...DEFAULT_TIMING,
    ...opts.testing?.timing,
    ...(opts.requestTimeoutMs !== undefined && opts.requestTimeoutMs > 0 ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  };
  const onEvent = opts.onEvent ?? (() => {});
  const conn = createConnection({
    authData,
    fetch: opts.fetch ?? fetch,
    logger,
    clock,
    timing,
    mode: { kind: "client" },
    emit: onEvent,
  });
  let state: ClientState = "idle";
  let connecting: Promise<Result<void, GMConnectError>> | null = null;
  let conversationsFetchedOnce = false;
  const quietWaiters = new Set<() => void>();

  const notReady = (action: ActionType): GMRpcError | null => {
    const reason = conn.stopReason();
    if (reason?.kind === "authExpired") return reason.error;
    const name = actionName(action);
    if (state === "closed" || reason !== null) {
      return new GMConnectionClosedError({
        action: name,
        message: `Cannot send ${name}: the Google Messages connection is closed. Nothing was sent; open a new connection and try again.`,
      });
    }
    if (state !== "ready") {
      return new GMNotConnectedError({
        action: name,
        message: `Cannot send ${name}: connect() has not finished. Nothing was sent; call connect() first.`,
      });
    }
    return null;
  };

  const typed = <Desc extends DescMessage>(rpc: DataRpc, schema: Desc): Result<MessageShape<Desc>, GMDecodeError> =>
    isMessage(rpc.decrypted, schema)
      ? Result.ok(rpc.decrypted)
      : Result.err(
          new GMDecodeError({
            action: actionName(rpc.data.action),
            message: `The phone answered ${actionName(rpc.data.action)} with ${rpc.decrypted?.$typeName ?? "no decodable payload"} instead of ${schema.typeName}; nothing was changed. This may be a protocol change.`,
          }),
        );

  const call = async <Desc extends DescMessage>(params: SendParams, schema: Desc): Promise<Result<MessageShape<Desc>, GMRpcError>> => {
    const blocked = notReady(params.action);
    if (blocked !== null) return Result.err(blocked);
    const res = await conn.session.send(params);
    if (res.isErr()) return Result.err(res.error);
    return typed(res.value, schema);
  };

  const fail = async (error: GMConnectError): Promise<Result<void, GMConnectError>> => {
    state = "failed";
    await conn.close();
    return Result.err(error);
  };

  const doConnect = async (signal?: AbortSignal): Promise<Result<void, GMConnectError>> => {
    if (authData.tachyonAuthToken === null || authData.tachyonAuthToken.length === 0) {
      return Result.err(
        new GMNotLoggedInError({
          missing: "tachyonToken",
          message: "This Google Messages session has no auth token, so it was never paired or the pairing did not finish. Pair the phone first.",
        }),
      );
    }
    if (authData.browser === null) {
      return Result.err(
        new GMNotLoggedInError({
          missing: "browser",
          message: "This Google Messages session has no paired browser identity, so pairing did not finish. Pair the phone first.",
        }),
      );
    }
    if (!AuthData.isLoggedIn(authData)) {
      return Result.err(
        new GMNotLoggedInError({
          missing: "cookies",
          message: "This Google-account session has no Google cookies stored. Pair again with fresh cookies.",
        }),
      );
    }
    state = "connecting";
    // close() can run while connect() awaits; each step below checks for it.
    const stopped = (): GMConnectError | null => {
      const reason = conn.stopReason();
      return reason === null ? null : reason.kind === "closed" ? closedDuringConnect() : reason.error;
    };
    const refreshed = await conn.refreshTokenIfNeeded(signal);
    if (refreshed.isErr()) return fail(stopped() ?? refreshed.error);
    const opened = await conn.openLongPoll(signal);
    if (opened.isErr()) return fail(opened.error);
    // Started after close() already ran, the ack interval would never be stopped.
    const closedWhileOpening = stopped();
    if (closedWhileOpening !== null) return fail(closedWhileOpening);
    conn.session.startAckInterval();
    await conn.awaitStartupBacklog(signal);
    logger.debug("sending startup acks before GET_UPDATES");
    await conn.session.flushAcks();
    if ((await Clock.sleep(clock, timing.postAckDelayMs, signal)) === "aborted") return fail(aborted("connecting"));
    const closedBeforeActive = stopped();
    if (closedBeforeActive !== null) return fail(closedBeforeActive);
    const sessionId = conn.session.resetSessionId();
    const active = await conn.session.sendNoResponse(GMRequests.setActiveSession(sessionId));
    if (active.isErr()) return fail(active.error);
    if (signal?.aborted) return fail(aborted("connecting"));
    const closedAfterActive = stopped();
    if (closedAfterActive !== null) return fail(closedAfterActive);
    state = "ready";
    logger.debug("connected");
    return Result.ok();
  };

  const closedDuringConnect = (): GMConnectionClosedError =>
    new GMConnectionClosedError({ action: "connecting", message: "The client was closed while connecting; nothing was sent." });

  return {
    authData,

    connect(connectOpts) {
      if (state === "ready") return Promise.resolve(Result.ok());
      if (state === "closed" || state === "failed") {
        return Promise.resolve(
          Result.err(
            new GMConnectionClosedError({
              action: "connecting",
              message: "This client was already closed or failed to connect; create a new GMClient to connect again.",
            }),
          ),
        );
      }
      if (connecting === null) connecting = doConnect(connectOpts?.signal);
      return connecting;
    },

    async close() {
      if (state !== "failed") state = "closed";
      for (const wake of [...quietWaiters]) wake();
      await conn.close();
      // A connect() in progress stops at its next step; wait for it so nothing
      // changes AuthData or emits events after close() resolves.
      if (connecting !== null) await connecting;
    },

    waitForQuiet({ quietMs, maxMs }) {
      return new Promise<void>((resolve) => {
        const start = clock.now().getTime();
        let timer: ReturnType<Clock["setTimeout"]> | null = null;
        const finish = (): void => {
          if (timer !== null) clock.clearTimeout(timer);
          quietWaiters.delete(finish);
          resolve();
        };
        const schedule = (): void => {
          const now = clock.now().getTime();
          const deadline = start + maxMs;
          const quietAt = Math.max(start, conn.lastDataAt()) + quietMs;
          if (now >= deadline || now >= quietAt || state === "closed" || conn.stopReason() !== null) {
            finish();
            return;
          }
          timer = clock.setTimeout(schedule, Math.min(deadline, quietAt) - now);
        };
        quietWaiters.add(finish);
        schedule();
      });
    },

    listConversations(req) {
      const first = !conversationsFetchedOnce;
      conversationsFetchedOnce = true;
      return call(GMRequests.listConversations(req, first), ListConversationsResponseSchema);
    },

    fetchMessages(req) {
      return call(GMRequests.fetchMessages(req), ListMessagesResponseSchema);
    },

    async getConversation(conversationId) {
      const res = await call(GMRequests.getConversation(conversationId), GetConversationResponseSchema);
      if (res.isErr()) return Result.err(res.error);
      const conversation = res.value.conversation;
      if (conversation === undefined) {
        return Result.err(
          new GMDecodeError({
            action: "GET_CONVERSATION",
            message: "The phone answered GET_CONVERSATION without a conversation; it may have been deleted. Nothing was changed.",
          }),
        );
      }
      return Result.ok(conversation);
    },

    getOrCreateConversation(req) {
      return call(GMRequests.getOrCreateConversation(req), GetOrCreateConversationResponseSchema);
    },

    sendMessage(req) {
      return call(GMRequests.sendMessage(req), SendMessageResponseSchema);
    },

    sendReaction(req) {
      return call(GMRequests.sendReaction(req), SendReactionResponseSchema);
    },

    async markRead(conversationId, messageId) {
      const params = GMRequests.markRead(conversationId, messageId);
      const blocked = notReady(params.action);
      if (blocked !== null) return Result.err(blocked);
      const res = await conn.session.send(params);
      return res.isErr() ? Result.err(res.error) : Result.ok();
    },

    listContacts() {
      return call(GMRequests.listContacts(), ListContactsResponseSchema);
    },

    listTopContacts() {
      return call(GMRequests.listTopContacts(), ListTopContactsResponseSchema);
    },

    async unpair() {
      if (AuthData.isGoogleAccount(authData)) {
        const res = await conn.session.sendNoResponse(GMRequests.unpairGaia(authData.pairingId));
        return res.isErr() ? Result.err(res.error) : Result.ok();
      }
      if (authData.tachyonAuthToken === null || authData.browser === null) return Result.ok();
      const res = await GMHttp.request(conn.http, {
        url: REVOKE_RELAY_PAIRING_URL,
        action: "unpairing",
        contentType: CONTENT_TYPE_PROTOBUF,
        requestSchema: RevokeRelayPairingRequestSchema,
        message: GMRequests.revokeRelayPairing(authData, randomUUID()),
        responseSchema: RevokeRelayPairingResponseSchema,
      });
      return res.isErr() ? Result.err(res.error) : Result.ok();
    },
  };
};

export const GMClient = { create: createClient } as const;

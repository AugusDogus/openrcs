import { randomUUID } from "node:crypto";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Result } from "better-result";

import {
  DeviceSchema,
  GaiaPairingErrorCode,
  GaiaPairingRequestContainerSchema,
  GaiaPairingResponseContainerSchema,
  SignInGaiaRequestSchema,
  SignInGaiaResponseSchema,
  type GaiaPairingResponseContainer,
  type SignInGaiaRequest,
  type SignInGaiaResponse,
} from "@/gen/gmproto/authentication_pb";
import { ActionType, MessageType } from "@/gen/gmproto/rpc_pb";

import { AuthData } from "./auth-data";
import { createConnection, DEFAULT_TIMING, type GMConnection, type GMTiming, type StopReason } from "./client";
import { Clock } from "./clock";
import { browserDetails, configVersion, CONTENT_TYPE_PBLITE, GOOGLE_NETWORK, SIGN_IN_GAIA_URL } from "./constants";
import { Jwk } from "./crypto/jwk";
import { PairingSession } from "./crypto/ukey2";
import {
  GaiaCancelledError,
  GaiaIncorrectEmojiError,
  GaiaInitTimeoutError,
  GaiaNoDevicesError,
  GaiaPairingFailedError,
  GaiaTimeoutError,
  GMAuthExpiredError,
  GMConnectionClosedError,
  GMDecodeError,
  type GaiaPairingError,
  type GMConnectError,
  type GMTransportError,
} from "./errors";
import type { GoogleCookies } from "./google-cookies";
import { GMHttp, type FetchFn } from "./http";
import { GMLogger } from "./logger";
import type { SendParams } from "./session";

// libgm pair_google.go: Google-account ("Gaia") pairing. StartGaiaPairing and
// FinishGaiaPairing, with openmessage's 5-minute confirm timeout that cancels
// (and so sends CANCEL_GAIA_PAIRING) rather than letting a deadline lapse.

export type PairingTiming = {
  /** libgm GaiaInitTimeout. */
  readonly gaiaInitTimeoutMs: number;
  /** openmessage gaiaConfirmTimeout: default wait for the emoji tap. */
  readonly gaiaConfirmTimeoutMs: number;
  /** libgm completePairing sleeps this long before reconnecting after a QR pair. */
  readonly qrSettleMs: number;
  /** Default wait for a QR scan. */
  readonly qrWaitMs: number;
};

export const DEFAULT_PAIRING_TIMING: PairingTiming = {
  gaiaInitTimeoutMs: 20_000,
  gaiaConfirmTimeoutMs: 5 * 60_000,
  qrSettleMs: 2_000,
  qrWaitMs: 5 * 60_000,
};

export type PairingTestingOptions = {
  readonly timing?: Partial<GMTiming & PairingTiming>;
  readonly clock?: Clock;
};

/** Opaque handle of a started Gaia pairing. Pass it to finish() or cancel() exactly once. */
export type GaiaPairingAttempt = { readonly kind: "gaiaPairingAttempt"; readonly id: string };

type DestRegDevice = { readonly regId: string; readonly unknownInt: bigint; readonly lastSeenMicros: bigint | null };

type AttemptState = {
  readonly conn: GMConnection;
  readonly authData: AuthData;
  readonly session: PairingSession;
  readonly serverInit: GaiaPairingResponseContainer;
  readonly nextKey: Uint8Array;
  readonly device: DestRegDevice;
  readonly timing: PairingTiming;
};

const attempts = new WeakMap<GaiaPairingAttempt, AttemptState>();

const PAIRING_TTL_MICROS = 300n * 1_000_000n;

const EMOJI_SVG_TEMPLATE = "https://fonts.gstatic.com/s/e/notoemoji/latest/%s/emoji.svg";

/** libgm GetEmojiSVG: code points in lowercase hex joined by "_". */
const emojiImageUrl = (emoji: string): string =>
  EMOJI_SVG_TEMPLATE.replace(
    "%s",
    Array.from(emoji)
      .map((ch) => (ch.codePointAt(0) ?? 0).toString(16).replace(/^0+/, ""))
      .join("_"),
  );

const HEX32 = /^[0-9a-f]{32}$/;

/** Go uuid.Parse (canonical, 32-hex, urn:uuid:, braces) to canonical lowercase. */
const parseUuid = (value: string): string | null => {
  let v = value.trim().toLowerCase();
  if (v.startsWith("urn:uuid:")) v = v.slice("urn:uuid:".length);
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
  const hex = v.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v.replaceAll("-", "") : v;
  if (!HEX32.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const GaiaRequests = {
  /** libgm signInGaiaGetToken's request (baseSignInGaiaPayload + the SPKI refresh key). */
  signIn(authData: AuthData, requestId: string): SignInGaiaRequest {
    return create(SignInGaiaRequestSchema, {
      authMessage: { requestID: requestId, network: GOOGLE_NETWORK, configVersion: configVersion() },
      inner: {
        deviceID: { unknownInt1: 3, deviceID: `messages-web-${authData.sessionId.replaceAll("-", "").toLowerCase()}` },
        someData: { someData: Jwk.publicKeySpkiDer(authData.refreshKey) },
      },
      network: GOOGLE_NETWORK,
    });
  },

  /** libgm sendGaiaPairingMessage's SendMessageParams. */
  pairingMessage(session: PairingSession, action: ActionType, data: Uint8Array): SendParams {
    const init = action !== ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED;
    const container = create(GaiaPairingRequestContainerSchema, {
      pairingAttemptID: session.uuid,
      browserDetails: browserDetails(),
      startTimestamp: BigInt(session.start.getTime()),
      data,
      proposedVerificationCodeVersion: init ? 1 : 0,
      proposedKeyDerivationVersion: init ? 1 : 0,
    });
    return {
      action,
      payload: { kind: "plain", bytes: toBinary(GaiaPairingRequestContainerSchema, container) },
      ttl: { customMicros: PAIRING_TTL_MICROS },
      messageType: init ? MessageType.GAIA_2 : MessageType.BUGLE_MESSAGE,
    };
  },

  /** libgm cancelGaiaPairing. */
  cancel(session: PairingSession): SendParams {
    return {
      action: ActionType.CANCEL_GAIA_PAIRING,
      requestId: session.uuid,
      ttl: { customMicros: PAIRING_TTL_MICROS },
      messageType: MessageType.GAIA_2,
    };
  },

  /** libgm StartGaiaPairing's primary device choice: unknownInt4 == 1, newest last-seen first. */
  primaryDevices(response: SignInGaiaResponse): DestRegDevice[] {
    const devices: DestRegDevice[] = [];
    const items3 = response.deviceData?.unknownItems3 ?? [];
    for (const item of response.deviceData?.unknownItems2 ?? []) {
      if (item.unknownInt4 !== 1) continue;
      // libgm overwrites LastSeen for every matching item, so the last one wins.
      const seen = items3.filter((i) => i.destOrSourceUUID === item.destOrSourceUUID).at(-1);
      devices.push({
        regId: item.destOrSourceUUID,
        unknownInt: item.unknownBigInt7,
        lastSeenMicros: seen === undefined ? null : seen.unknownTimestampMicroseconds,
      });
    }
    return devices.sort((a, b) => {
      const at = a.lastSeenMicros;
      const bt = b.lastSeenMicros;
      if (at === bt) return 0;
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt > at ? 1 : -1;
    });
  },

  emojiImageUrl,
} as const;

const cookiesRejected = (status: number): GMAuthExpiredError =>
  new GMAuthExpiredError({
    reason: "cookiesRejected",
    status,
    message: `Google rejected the account cookies (HTTP ${status}); they have expired or belong to a signed-out session. Nothing was paired; sign in to Google again and retry.`,
  });

const cancelledByCaller = (): GaiaCancelledError =>
  new GaiaCancelledError({ reason: "aborted", message: "Google-account pairing was cancelled before the phone confirmed; nothing was paired." });

const mapConnectError = (error: GMConnectError): GaiaPairingError => {
  switch (error._tag) {
    case "GMAbortedError":
      return cancelledByCaller();
    case "GMNotLoggedInError":
      return new GaiaPairingFailedError({ errorType: null, errorCode: null, message: error.message, cause: error });
    default:
      return error;
  }
};

const mapTransportError = (error: GMTransportError): GaiaPairingError =>
  error._tag === "GMAbortedError"
    ? cancelledByCaller()
    : (error._tag === "GMHttpError" || error._tag === "GMRequestError") && (error.status === 401 || error.status === 403)
      ? cookiesRejected(error.status)
      : error;

type ExchangeOutcome =
  | { readonly kind: "response"; readonly container: GaiaPairingResponseContainer }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  /** The long poll had already stopped, so nothing was sent: the answer could never arrive. */
  | { readonly kind: "stopped"; readonly error: GaiaPairingError }
  | { readonly kind: "error"; readonly error: GaiaPairingError };

const connectionLost = (reason: StopReason): GaiaPairingError =>
  reason.kind === "authExpired" && reason.error.status !== null
    ? cookiesRejected(reason.error.status)
    : new GMConnectionClosedError({
        action: "Gaia pairing",
        message:
          "The connection to Google Messages was lost before the phone answered, so nothing was paired. Start pairing again.",
      });

/** libgm sendGaiaPairingMessage: send and wait for the unencrypted GaiaPairingResponseContainer. */
const exchange = async (
  conn: GMConnection,
  params: SendParams,
  wait: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<ExchangeOutcome> => {
  // Without a long poll the answer cannot arrive; waiting would only run out the timeout.
  const stopped = conn.stopReason();
  if (stopped !== null) return { kind: "stopped", error: connectionLost(stopped) };
  const sent = await conn.session.sendAsync(params);
  if (sent.isErr()) {
    return sent.error._tag === "GMAbortedError" ? { kind: "aborted" } : { kind: "error", error: mapTransportError(sent.error) };
  }
  const outcome = await sent.value.wait({ timeoutMs: wait.timeoutMs, signal: wait.signal });
  switch (outcome.kind) {
    case "timeout":
      return { kind: "timeout" };
    case "aborted":
      return { kind: "aborted" };
    case "failed":
      return {
        kind: "error",
        error:
          outcome.error._tag === "GMNoResponsePayloadError"
            ? new GaiaPairingFailedError({ errorType: null, errorCode: null, message: outcome.error.message, cause: outcome.error })
            : outcome.error,
      };
    case "response":
      try {
        return { kind: "response", container: fromBinary(GaiaPairingResponseContainerSchema, outcome.rpc.data.unencryptedData) };
      } catch (cause) {
        return {
          kind: "error",
          error: new GMDecodeError({
            action: "Gaia pairing",
            message: "The phone's pairing answer is not a GaiaPairingResponseContainer; nothing was paired. Try again.",
            cause,
          }),
        };
      }
  }
};

const sendCancel = async (conn: GMConnection, session: PairingSession): Promise<void> => {
  const res = await conn.session.sendNoResponse(GaiaRequests.cancel(session));
  if (res.isErr()) conn.logger.warn("failed to send gaia pairing cancel", { error: res.error._tag });
};

/** FinishGaiaPairing's error-code mapping; null when the phone accepted. */
const finishError = (container: GaiaPairingResponseContainer): GaiaPairingError | null => {
  if (container.finishErrorType === 0) return null;
  const code = container.finishErrorCode;
  const codeName = GaiaPairingErrorCode[code] ?? String(code);
  switch (code) {
    case GaiaPairingErrorCode.WRONG_VERIFICATION_CODE_SELECTED:
      return new GaiaIncorrectEmojiError({
        message: "A different emoji was tapped on the phone than the one shown here, so pairing was refused. Start pairing again and tap the matching emoji.",
      });
    case GaiaPairingErrorCode.USER_CANCELED_VERIFICATION:
      return new GaiaCancelledError({ reason: "phone", message: "Pairing was cancelled on the phone; nothing was paired. Start again when ready." });
    case GaiaPairingErrorCode.REQUEST_OUT_OF_DATE:
    case GaiaPairingErrorCode.REQUEST_NOT_RECEIVED_QUICKLY:
    case GaiaPairingErrorCode.VERIFICATION_TIMED_OUT:
      return new GaiaTimeoutError({
        code: codeName,
        message: `The phone reported that pairing timed out (${codeName}); nothing was paired. Start again and tap the emoji promptly.`,
      });
    case GaiaPairingErrorCode.USER_DENIED_VERIFICATION_NOT_ME:
      return new GaiaCancelledError({ reason: "notMe", message: `"This is not me" was chosen on the phone, so pairing was refused; nothing was paired.` });
    default:
      return new GaiaPairingFailedError({
        errorType: container.finishErrorType,
        errorCode: codeName,
        message: `The phone refused pairing with error ${container.finishErrorType}/${codeName}; nothing was paired. Try again, and update Google Messages on the phone if it repeats.`,
      });
  }
};

const start = async (opts: {
  cookies: GoogleCookies;
  fetch?: FetchFn;
  logger?: GMLogger;
  signal?: AbortSignal;
  testing?: PairingTestingOptions;
}): Promise<Result<{ emoji: string; emojiImageUrl: string; attempt: GaiaPairingAttempt }, GaiaPairingError>> => {
  const logger = opts.logger ?? GMLogger.noop;
  const clock = opts.testing?.clock ?? Clock.real;
  const timing: GMTiming & PairingTiming = { ...DEFAULT_TIMING, ...DEFAULT_PAIRING_TIMING, ...opts.testing?.timing };
  const authData = AuthData.createForPairing();
  authData.cookies = { ...opts.cookies };
  const conn = createConnection({
    authData,
    fetch: opts.fetch ?? fetch,
    logger,
    clock,
    timing,
    mode: { kind: "pairing" },
    emit: () => {},
  });
  const failWith = async (error: GaiaPairingError): Promise<Result<never, GaiaPairingError>> => {
    await conn.close();
    return Result.err(error);
  };

  // signInGaiaGetToken
  const signIn = await GMHttp.request(conn.http, {
    url: SIGN_IN_GAIA_URL,
    action: "signing in to Google",
    contentType: CONTENT_TYPE_PBLITE,
    requestSchema: SignInGaiaRequestSchema,
    message: GaiaRequests.signIn(authData, randomUUID()),
    responseSchema: SignInGaiaResponseSchema,
    signal: opts.signal,
  });
  if (signIn.isErr()) return failWith(mapTransportError(signIn.error));
  const response = signIn.value;
  const device = response.deviceData?.deviceWrapper?.device;
  if (device === undefined) {
    return failWith(
      new GMDecodeError({
        action: "signing in to Google",
        message: "Google's sign-in answer had no browser device; nothing was paired. Try again with fresh cookies.",
      }),
    );
  }
  AuthData.applyTokenData(authData, response.tokenData?.tachyonAuthToken ?? new Uint8Array(0), response.tokenData?.TTL ?? 0n, clock.now());
  const mobile = clone(DeviceSchema, device);
  mobile.sourceID = device.sourceID.toLowerCase();
  authData.mobile = mobile;
  authData.browser = device;

  const devices = GaiaRequests.primaryDevices(response);
  const chosen = devices[0];
  if (chosen === undefined) {
    return failWith(
      new GaiaNoDevicesError({
        message:
          "This Google account has no phone with Google Messages set up for account pairing. Open Google Messages on the phone, make sure it is signed in to this account (Settings > Google account), then try again.",
      }),
    );
  }
  if (devices.length > 1) logger.warn("found multiple primary-looking devices for gaia pairing", { count: devices.length });
  const destRegId = parseUuid(chosen.regId);
  if (destRegId === null) {
    return failWith(
      new GaiaPairingFailedError({
        errorType: null,
        errorCode: null,
        message: "Google listed the phone with a malformed registration id; nothing was paired. Try again.",
      }),
    );
  }
  authData.destRegId = destRegId;

  const opened = await conn.openLongPoll(opts.signal);
  if (opened.isErr()) {
    const error = opened.error;
    return failWith(
      error._tag === "GMAuthExpiredError" && error.status !== null ? cookiesRejected(error.status) : mapConnectError(error),
    );
  }

  const session = PairingSession.create();
  const init = await exchange(conn, GaiaRequests.pairingMessage(session, ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT, session.initPayload), {
    timeoutMs: timing.gaiaInitTimeoutMs,
    signal: opts.signal,
  });
  if (init.kind !== "response") {
    await sendCancel(conn, session);
    if (init.kind === "timeout") {
      return failWith(
        new GaiaInitTimeoutError({
          multipleDevices: devices.length > 1,
          message:
            devices.length > 1
              ? "The phone did not answer the pairing request within 20 s. This account has several phones; the newest one was tried. Open Google Messages on the phone you want to pair and try again."
              : "The phone did not answer the pairing request within 20 s. Open Google Messages on the phone, check it is online, and try again.",
        }),
      );
    }
    return failWith(init.kind === "aborted" ? cancelledByCaller() : init.error);
  }
  const processed = PairingSession.processServerInit(session, init.container);
  if (processed.isErr()) {
    await sendCancel(conn, session);
    return failWith(
      new GaiaPairingFailedError({
        errorType: null,
        errorCode: null,
        message: `The phone's pairing handshake was invalid (${processed.error.message}); nothing was paired. Try again.`,
        cause: processed.error,
      }),
    );
  }
  const attempt: GaiaPairingAttempt = { kind: "gaiaPairingAttempt", id: session.uuid };
  attempts.set(attempt, {
    conn,
    authData,
    session,
    serverInit: init.container,
    nextKey: processed.value.nextKey,
    device: chosen,
    timing,
  });
  return Result.ok({ emoji: processed.value.emoji, emojiImageUrl: emojiImageUrl(processed.value.emoji), attempt });
};

const finish = async (
  attempt: GaiaPairingAttempt,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Result<{ authData: AuthData; phoneId: string }, GaiaPairingError>> => {
  const state = attempts.get(attempt);
  if (state === undefined) {
    return Result.err(
      new GMConnectionClosedError({
        action: "Gaia pairing",
        message: "This pairing attempt already finished or was cancelled; start a new one.",
      }),
    );
  }
  attempts.delete(attempt);
  const { conn, authData, session } = state;
  const timeoutMs = opts.timeoutMs ?? state.timing.gaiaConfirmTimeoutMs;
  const failWith = async (error: GaiaPairingError): Promise<Result<never, GaiaPairingError>> => {
    await conn.close();
    return Result.err(error);
  };
  const done = await exchange(
    conn,
    GaiaRequests.pairingMessage(session, ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED, session.finishPayload),
    { timeoutMs, signal: opts.signal },
  );
  switch (done.kind) {
    case "timeout":
      await sendCancel(conn, session);
      return failWith(
        new GaiaTimeoutError({
          code: null,
          message: `The phone did not confirm within ${Math.round(timeoutMs / 1000)} s, so pairing was cancelled. Start again when you can tap the emoji in Google Messages.`,
        }),
      );
    case "aborted":
      await sendCancel(conn, session);
      return failWith(cancelledByCaller());
    case "stopped":
      // The phone still shows the emoji prompt; dismiss it.
      await sendCancel(conn, session);
      return failWith(done.error);
    case "error":
      return failWith(done.error);
    case "response":
      break;
  }
  const refused = finishError(done.container);
  if (refused !== null) return failWith(refused);
  const derived = PairingSession.deriveRequestCrypto(state.nextKey, state.serverInit.confirmedKeyDerivationVersion);
  if (derived.isErr()) {
    return failWith(new GaiaPairingFailedError({ errorType: null, errorCode: null, message: derived.error.message, cause: derived.error }));
  }
  authData.requestCrypto = derived.value;
  authData.pairingId = session.uuid;
  await conn.close();
  return Result.ok({ authData, phoneId: `${authData.mobile?.sourceID ?? ""}/${state.device.unknownInt.toString()}` });
};

const cancel = async (attempt: GaiaPairingAttempt): Promise<void> => {
  const state = attempts.get(attempt);
  if (state === undefined) return;
  attempts.delete(attempt);
  await sendCancel(state.conn, state.session);
  await state.conn.close();
};

export const GaiaPairing = {
  /** SignInGaia, pick the phone, open the long poll, send CLIENT_INIT.
   *  Resolves with the emoji the user must tap on their phone. */
  start,
  /** Send CLIENT_FINISHED and wait for the phone (up to `timeoutMs`, default
   *  5 min, or until `signal` aborts, which sends CANCEL_GAIA_PAIRING). On
   *  success returns logged-in AuthData ready to persist. Closes its connection. */
  finish,
  cancel,
} as const;

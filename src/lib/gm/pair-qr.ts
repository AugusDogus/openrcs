import { randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { Result } from "better-result";

import {
  AuthenticationContainerSchema,
  RefreshPhoneRelayResponseSchema,
  RegisterPhoneRelayResponseSchema,
  URLDataSchema,
  type AuthenticationContainer,
  type PairedData,
} from "@/gen/gmproto/authentication_pb";

import { AuthData } from "./auth-data";
import { createConnection, DEFAULT_TIMING, type GMConnection, type GMTiming } from "./client";
import { Clock } from "./clock";
import {
  browserDetails,
  configVersion,
  CONTENT_TYPE_PROTOBUF,
  QR_CODE_URL_BASE,
  QR_NETWORK,
  REFRESH_PHONE_RELAY_URL,
  REGISTER_PHONE_RELAY_URL,
} from "./constants";
import type { AesCtrHelper } from "./crypto/aes-ctr";
import { Jwk } from "./crypto/jwk";
import {
  GMConnectionClosedError,
  QrPairingCancelledError,
  QrPairingTimeoutError,
  type GMConnectError,
  type GMTransportError,
  type QrPairingError,
} from "./errors";
import { GMHttp, type FetchFn } from "./http";
import { GMLogger } from "./logger";
import { DEFAULT_PAIRING_TIMING, type PairingTestingOptions, type PairingTiming } from "./pair-gaia";

// libgm pair.go: QR pairing. RegisterPhoneRelay, the QR URL, RefreshPhoneRelay,
// and waiting for the PairEvent Paired frame on the long poll.

/** Opaque handle of a started QR pairing. Finish it with waitForPair() or cancel(). */
export type QrPairingAttempt = { readonly kind: "qrPairingAttempt"; readonly id: string };

type Paired = { readonly kind: "paired"; readonly data: PairedData };

type PairSignal = {
  paired: Paired | null;
  readonly listeners: Set<(paired: Paired) => void>;
};

type AttemptState = {
  readonly conn: GMConnection;
  readonly authData: AuthData;
  readonly timing: PairingTiming;
  /** Filled by the connection's onPair, possibly before waitForPair() is called. */
  readonly pair: PairSignal;
};

const attempts = new WeakMap<QrPairingAttempt, AttemptState>();

export const QrRequests = {
  /** libgm RegisterPhoneRelay's AuthenticationContainer (binary protobuf). */
  registerPhoneRelay(authData: AuthData, requestId: string): AuthenticationContainer {
    return create(AuthenticationContainerSchema, {
      authMessage: { requestID: requestId, network: QR_NETWORK, configVersion: configVersion() },
      browserDetails: browserDetails(),
      data: {
        case: "keyData",
        value: { ecdsaKeys: { field1: 2n, encryptedKeys: Jwk.publicKeySpkiDer(authData.refreshKey) } },
      },
    });
  },

  /** libgm RefreshPhoneRelay's AuthenticationContainer. */
  refreshPhoneRelay(authData: AuthData, requestId: string): AuthenticationContainer {
    return create(AuthenticationContainerSchema, {
      authMessage: {
        requestID: requestId,
        network: QR_NETWORK,
        tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
        configVersion: configVersion(),
      },
    });
  },

  /** libgm GenerateQRCodeData: QR_CODE_URL_BASE + base64(URLData{pairingKey, aesKey, hmacKey}). */
  qrUrl(pairingKey: Uint8Array, crypto: AesCtrHelper): string {
    const urlData = create(URLDataSchema, { pairingKey, AESKey: crypto.aesKey, HMACKey: crypto.hmacKey });
    return QR_CODE_URL_BASE + Buffer.from(toBinary(URLDataSchema, urlData)).toString("base64");
  },
} as const;

const mapError = (error: GMTransportError | GMConnectError): QrPairingError => {
  switch (error._tag) {
    case "GMAbortedError":
      return new QrPairingCancelledError({ message: "QR pairing was cancelled before a phone scanned the code; nothing was paired." });
    case "GMNotLoggedInError":
      return new GMConnectionClosedError({ action: "QR pairing", message: error.message });
    default:
      return error;
  }
};

const start = async (opts: {
  fetch?: FetchFn;
  logger?: GMLogger;
  signal?: AbortSignal;
  testing?: PairingTestingOptions;
}): Promise<Result<{ qrUrl: string; attempt: QrPairingAttempt }, QrPairingError>> => {
  const logger = opts.logger ?? GMLogger.noop;
  const clock = opts.testing?.clock ?? Clock.real;
  const timing: GMTiming & PairingTiming = { ...DEFAULT_TIMING, ...DEFAULT_PAIRING_TIMING, ...opts.testing?.timing };
  const authData = AuthData.createForPairing();
  const pair: PairSignal = { paired: null, listeners: new Set() };
  const conn = createConnection({
    authData,
    fetch: opts.fetch ?? fetch,
    logger,
    clock,
    timing,
    mode: {
      kind: "pairing",
      onPair: (data) => {
        const paired: Paired = { kind: "paired", data };
        pair.paired = paired;
        for (const listener of [...pair.listeners]) listener(paired);
      },
    },
    emit: () => {},
  });

  const registered = await GMHttp.request(conn.http, {
    url: REGISTER_PHONE_RELAY_URL,
    action: "registering for QR pairing",
    contentType: CONTENT_TYPE_PROTOBUF,
    requestSchema: AuthenticationContainerSchema,
    message: QrRequests.registerPhoneRelay(authData, randomUUID()),
    responseSchema: RegisterPhoneRelayResponseSchema,
    signal: opts.signal,
  });
  if (registered.isErr()) {
    await conn.close();
    return Result.err(mapError(registered.error));
  }
  const reg = registered.value;
  AuthData.applyTokenData(authData, reg.authKeyData?.tachyonAuthToken ?? new Uint8Array(0), reg.authKeyData?.TTL ?? 0n, clock.now());
  const opened = await conn.openLongPoll(opts.signal);
  if (opened.isErr()) {
    await conn.close();
    return Result.err(mapError(opened.error));
  }
  const attempt: QrPairingAttempt = { kind: "qrPairingAttempt", id: randomUUID() };
  attempts.set(attempt, { conn, authData, timing, pair });
  return Result.ok({ qrUrl: QrRequests.qrUrl(reg.pairingKey, authData.requestCrypto), attempt });
};

const finished = (): GMConnectionClosedError =>
  new GMConnectionClosedError({ action: "QR pairing", message: "This QR pairing attempt already finished or was cancelled; start a new one." });

const refresh = async (attempt: QrPairingAttempt): Promise<Result<string, QrPairingError>> => {
  const state = attempts.get(attempt);
  if (state === undefined) return Result.err(finished());
  const res = await GMHttp.request(state.conn.http, {
    url: REFRESH_PHONE_RELAY_URL,
    action: "refreshing the QR code",
    contentType: CONTENT_TYPE_PROTOBUF,
    requestSchema: AuthenticationContainerSchema,
    message: QrRequests.refreshPhoneRelay(state.authData, randomUUID()),
    responseSchema: RefreshPhoneRelayResponseSchema,
  });
  if (res.isErr()) return Result.err(mapError(res.error));
  return Result.ok(QrRequests.qrUrl(res.value.pairKey, state.authData.requestCrypto));
};

type WaitResult = { readonly kind: "paired"; readonly paired: Paired } | { readonly kind: "timeout" } | { readonly kind: "aborted" } | { readonly kind: "stopped" };

const waitForPaired = (state: AttemptState, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> => {
  if (state.pair.paired !== null) return Promise.resolve({ kind: "paired", paired: state.pair.paired });
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  const { clock } = state.conn;
  return new Promise((resolve) => {
    let done = false;
    let unsubscribeStop = (): void => {};
    const finish = (result: WaitResult): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      unsubscribeStop();
      state.pair.listeners.delete(onPaired);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onPaired = (paired: Paired): void => finish({ kind: "paired", paired });
    const onAbort = (): void => finish({ kind: "aborted" });
    const timer = clock.setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    state.pair.listeners.add(onPaired);
    signal?.addEventListener("abort", onAbort, { once: true });
    // The long poll can give up (or Google can reject it) while we wait.
    unsubscribeStop = state.conn.onStopped(() => finish({ kind: "stopped" }));
    if (done) unsubscribeStop();
  });
};

const waitForPair = async (
  attempt: QrPairingAttempt,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Result<{ authData: AuthData; phoneId: string }, QrPairingError>> => {
  const state = attempts.get(attempt);
  if (state === undefined) return Result.err(finished());
  const timeoutMs = opts.timeoutMs ?? state.timing.qrWaitMs;
  const result = await waitForPaired(state, timeoutMs, opts.signal);
  if (result.kind !== "paired") {
    attempts.delete(attempt);
    const reason = state.conn.stopReason();
    await state.conn.close();
    switch (result.kind) {
      case "timeout":
        return Result.err(
          new QrPairingTimeoutError({
            waitedMs: timeoutMs,
            message: `No phone scanned the QR code within ${Math.round(timeoutMs / 1000)} s; nothing was paired. Start again and scan the code in Google Messages > Device pairing.`,
          }),
        );
      case "aborted":
        return Result.err(new QrPairingCancelledError({ message: "QR pairing was cancelled before a phone scanned the code; nothing was paired." }));
      case "stopped":
        return Result.err(
          reason !== null && reason.kind !== "closed"
            ? mapError(reason.error)
            : new GMConnectionClosedError({ action: "QR pairing", message: "The pairing connection closed before a phone scanned the code; start again." }),
        );
    }
  }
  attempts.delete(attempt);
  // libgm completePairing: let the phone save the pair data before the session reconnects.
  await Clock.sleep(state.conn.clock, state.timing.qrSettleMs);
  await state.conn.close();
  return Result.ok({ authData: state.authData, phoneId: result.paired.data.mobile?.sourceID ?? "" });
};

const cancel = async (attempt: QrPairingAttempt): Promise<void> => {
  const state = attempts.get(attempt);
  if (state === undefined) return;
  attempts.delete(attempt);
  await state.conn.close();
};

export const QrPairing = {
  start,
  /** RefreshPhoneRelay: a new QR URL for the same attempt (call every ~30 s). */
  refresh,
  /** Wait for the phone to scan (PairEvent Paired). Closes its connection.
   *  Waits ~2 s after success before resolving, as libgm does. */
  waitForPair,
  cancel,
} as const;

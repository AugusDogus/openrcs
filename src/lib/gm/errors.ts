import { TaggedError } from "better-result";

// Tagged errors of the Google Messages protocol layer (docs/gm-client-contract.md).
// Messages never contain cookies, tokens, keys, message bodies or phone numbers.
// `action` names the operation (an ActionType name such as "LIST_MESSAGES", or
// an HTTP step such as "polling" or "refreshing token").

/** Google answered with a non-2xx status and no decodable error message. */
export class GMHttpError extends TaggedError("GMHttpError")<{
  status: number;
  action: string;
  message: string;
}> {}

/** Google answered with a non-2xx status and a gmproto ErrorResponse message. */
export class GMRequestError extends TaggedError("GMRequestError")<{
  status: number;
  action: string;
  /** ErrorResponse.type (a gRPC-style status code) as a decimal string. */
  errorType: string;
  /** Google's own error text; never contains our secrets. */
  googleMessage: string;
  message: string;
}> {}

/** The request never got an HTTP response: DNS/TCP/TLS failure, reset, or our timeout. */
export class GMNetworkError extends TaggedError("GMNetworkError")<{
  action: string;
  reason: "network" | "timeout";
  message: string;
  cause?: unknown;
}> {}

/** The caller's AbortSignal fired before the operation finished. */
export class GMAbortedError extends TaggedError("GMAbortedError")<{
  action: string;
  message: string;
}> {}

/** A response or frame could not be decoded or decrypted. */
export class GMDecodeError extends TaggedError("GMDecodeError")<{
  action: string;
  message: string;
  cause?: unknown;
}> {}

/** The phone did not answer an RPC within the request timeout. A send may still be delivered. */
export class GMPhoneNotRespondingError extends TaggedError("GMPhoneNotRespondingError")<{
  action: string;
  waitedMs: number;
  message: string;
}> {}

/** The client was closed (or its long poll gave up) while the request waited. */
export class GMConnectionClosedError extends TaggedError("GMConnectionClosedError")<{
  action: string;
  message: string;
}> {}

/** The phone answered a data request only with frames that carry no response payload. */
export class GMNoResponsePayloadError extends TaggedError("GMNoResponsePayloadError")<{
  action: string;
  frames: number;
  accountSwitch: boolean;
  waitedMs: number;
  message: string;
}> {}

/** An RPC was attempted before connect() finished or after the connection failed. */
export class GMNotConnectedError extends TaggedError("GMNotConnectedError")<{
  action: string;
  message: string;
}> {}

/** Google rejected the session (401/403 on the long poll, or token refresh rejected). Re-pair. */
export class GMAuthExpiredError extends TaggedError("GMAuthExpiredError")<{
  reason: "pollingRejected" | "refreshRejected" | "cookiesRejected";
  status: number | null;
  message: string;
}> {}

/** AuthData has no paired session to connect with. */
export class GMNotLoggedInError extends TaggedError("GMNotLoggedInError")<{
  missing: "tachyonToken" | "browser" | "cookies";
  message: string;
}> {}

/** Errors of one HTTP round trip to Google. */
export type GMTransportError = GMHttpError | GMRequestError | GMNetworkError | GMDecodeError | GMAbortedError;

export type GMRpcError =
  | GMPhoneNotRespondingError
  | GMConnectionClosedError
  | GMNoResponsePayloadError
  | GMHttpError
  | GMRequestError
  | GMDecodeError
  | GMNotConnectedError
  | GMNetworkError
  | GMAbortedError
  | GMAuthExpiredError;

export type GMConnectError =
  | GMHttpError
  | GMRequestError
  | GMNetworkError
  | GMDecodeError
  | GMAbortedError
  | GMAuthExpiredError
  | GMNotLoggedInError
  | GMConnectionClosedError;

// ---- Google-account (Gaia) pairing ----

/** SignInGaia listed no phone that can be paired with this Google account. */
export class GaiaNoDevicesError extends TaggedError("GaiaNoDevicesError")<{ message: string }> {}

/** The user tapped a different emoji on the phone. */
export class GaiaIncorrectEmojiError extends TaggedError("GaiaIncorrectEmojiError")<{ message: string }> {}

/** Pairing was cancelled: on the phone ("phone", or "notMe" for "this is not me"), or by our caller ("aborted"). */
export class GaiaCancelledError extends TaggedError("GaiaCancelledError")<{
  reason: "phone" | "notMe" | "aborted";
  message: string;
}> {}

/** The phone did not confirm in time (ours or the phone's own timeout). */
export class GaiaTimeoutError extends TaggedError("GaiaTimeoutError")<{
  /** GaiaPairingErrorCode name when the phone reported the timeout, null for our own timeout. */
  code: string | null;
  message: string;
}> {}

/** The phone did not answer CLIENT_INIT within 20 s. */
export class GaiaInitTimeoutError extends TaggedError("GaiaInitTimeoutError")<{
  multipleDevices: boolean;
  message: string;
}> {}

/** The handshake failed for another reason (unknown finish error code, malformed server init). */
export class GaiaPairingFailedError extends TaggedError("GaiaPairingFailedError")<{
  errorType: number | null;
  errorCode: string | null;
  message: string;
  cause?: unknown;
}> {}

export type GaiaPairingError =
  | GaiaNoDevicesError
  | GaiaIncorrectEmojiError
  | GaiaCancelledError
  | GaiaTimeoutError
  | GaiaInitTimeoutError
  | GaiaPairingFailedError
  | GMAuthExpiredError
  | GMHttpError
  | GMRequestError
  | GMNetworkError
  | GMDecodeError
  | GMConnectionClosedError;

// ---- QR pairing ----

/** No phone scanned the QR code within the wait. */
export class QrPairingTimeoutError extends TaggedError("QrPairingTimeoutError")<{
  waitedMs: number;
  message: string;
}> {}

/** The caller aborted or cancelled the QR pairing attempt. */
export class QrPairingCancelledError extends TaggedError("QrPairingCancelledError")<{ message: string }> {}

export type QrPairingError =
  | QrPairingTimeoutError
  | QrPairingCancelledError
  | GMHttpError
  | GMRequestError
  | GMNetworkError
  | GMDecodeError
  | GMConnectionClosedError
  | GMAuthExpiredError;

import { TaggedError } from "better-result";

/**
 * Service-layer errors. `message` is plain, user-facing text (it reaches the
 * dashboard and MCP clients) and never contains cookies, tokens, keys,
 * message content, names or phone numbers. Internal context (operation,
 * user id, upstream error tag) lives in separate fields for logs.
 */

/** A database read or write failed. */
export class RcsStorageError extends TaggedError("RcsStorageError")<{
  operation: string;
  userId: string;
  cause: unknown;
  message: string;
}> {}

/** The user has no paired phone (no gm_session row, or it was unpaired). */
export class RcsNotPairedError extends TaggedError("RcsNotPairedError")<{
  userId: string;
  message: string;
}> {}

/** Google rejected the stored session; the user must pair again. */
export class RcsNeedsRepairError extends TaggedError("RcsNeedsRepairError")<{
  userId: string;
  reason: string;
  message: string;
}> {}

/**
 * The caller's DEK is not the one the session was sealed with (stale device
 * slot or grant from before a re-pair). Nothing can be decrypted with it.
 */
export class RcsKeyMismatchError extends TaggedError("RcsKeyMismatchError")<{
  userId: string;
  sessionDekId: string;
  clientDekId: string;
  message: string;
}> {}

/** The stored session could not be opened or parsed even though the key id matched. */
export class RcsSessionCorruptError extends TaggedError("RcsSessionCorruptError")<{
  userId: string;
  reason: string;
  message: string;
}> {}

/** Another invocation held the phone lease for longer than we were willing to wait. */
export class RcsPhoneBusyError extends TaggedError("RcsPhoneBusyError")<{
  userId: string;
  waitedMs: number;
  message: string;
}> {}

/** The lease expired and another invocation took it while we were working. */
export class RcsLeaseLostError extends TaggedError("RcsLeaseLostError")<{
  userId: string;
  message: string;
}> {}

/** Talking to the phone through Google failed. */
export class RcsPhoneError extends TaggedError("RcsPhoneError")<{
  userId: string;
  operation: string;
  /** `_tag` of the upstream src/lib/gm error, for logs. */
  gmTag: string;
  needsRepair: boolean;
  message: string;
}> {}

/** The request was cancelled (client disconnected or deadline passed) before the phone was used. */
export class RcsAbortedError extends TaggedError("RcsAbortedError")<{
  userId: string;
  operation: string;
  message: string;
}> {}

/** Errors any phone-backed operation can return. */
export type RcsPhoneAccessError =
  | RcsStorageError
  | RcsNotPairedError
  | RcsNeedsRepairError
  | RcsKeyMismatchError
  | RcsSessionCorruptError
  | RcsPhoneBusyError
  | RcsPhoneError
  | RcsAbortedError;

/** Structural view of any tagged error from src/lib/gm (GMRpcError, GMConnectError, ...). */
export type GmFailure = { readonly _tag: string; readonly message: string };

const AUTH_TAGS = new Set(["GMAuthExpiredError", "GMNotLoggedInError"]);

const httpStatusOf = (error: GmFailure): number | null =>
  "status" in error && typeof error.status === "number" ? error.status : null;

const REPAIR_MESSAGE =
  "Google signed this openrcs session out, so it can no longer reach your phone. Pair again from the openrcs dashboard. Messages already stored here are kept.";

/** True when the upstream error means the stored session is dead and only re-pairing helps. */
const needsRepair = (error: GmFailure): boolean => {
  if (AUTH_TAGS.has(error._tag)) return true;
  const status = httpStatusOf(error);
  return error._tag === "GMHttpError" && (status === 401 || status === 403);
};

/** Plain-language explanation of an upstream Google Messages error. */
const describeGm = (error: GmFailure): string => {
  if (needsRepair(error)) return REPAIR_MESSAGE;
  switch (error._tag) {
    case "GMPhoneNotRespondingError":
      return "Your phone did not respond in time. Make sure it is switched on, connected to the internet, and that Google Messages is installed, then try again.";
    case "GMConnectionClosedError":
      return "The connection to Google Messages closed before the phone answered. Try again in a moment.";
    case "GMHttpError": {
      const status = httpStatusOf(error);
      return `Google Messages answered with HTTP ${status ?? "error"}. This is usually temporary; try again in a minute.`;
    }
    case "GMRequestError": {
      const google =
        "googleMessage" in error && typeof error.googleMessage === "string" && error.googleMessage !== ""
          ? `: ${error.googleMessage}`
          : "";
      return `Google Messages rejected the request${google}. Try again in a minute; if it keeps failing, pair your phone again from the dashboard.`;
    }
    case "GMNetworkError":
      return "Could not reach Google Messages (network error or timeout). Check that openrcs can reach Google and try again in a moment.";
    case "GMAbortedError":
      return "The request was cancelled before Google Messages answered.";
    case "GMNotConnectedError":
      return "openrcs was not connected to Google Messages when it tried to reach your phone. Try again.";
    case "GMDecodeError":
    case "GMNoResponsePayloadError":
      return "Google Messages sent a response openrcs could not understand. Try again; if it keeps happening, the protocol may have changed.";
    default:
      return "Could not reach Google Messages. Check your connection and try again in a moment.";
  }
};

export const GmFailure = {
  needsRepair,
  describe: describeGm,
  repairMessage: REPAIR_MESSAGE,
  /** Wrap an upstream error for `operation` (e.g. "fetchMessages"). */
  toPhoneError: (userId: string, operation: string, error: GmFailure): RcsPhoneError =>
    new RcsPhoneError({
      userId,
      operation,
      gmTag: error._tag,
      needsRepair: needsRepair(error),
      message: describeGm(error),
    }),
} as const;

/** One log line for an error: tag, operation and ids only, never content. */
export const describeForLog = (error: { readonly _tag: string }): string => {
  const parts = [error._tag];
  if ("operation" in error && typeof error.operation === "string") parts.push(`op=${error.operation}`);
  if ("userId" in error && typeof error.userId === "string") parts.push(`user=${error.userId}`);
  if ("gmTag" in error && typeof error.gmTag === "string") parts.push(`gm=${error.gmTag}`);
  return parts.join(" ");
};

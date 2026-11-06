import { create } from "@bufbuild/protobuf";
import { Result, TaggedError } from "better-result";

import { ReceiveMessagesRequestSchema, type ReceiveMessagesRequest } from "@/gen/gmproto/client_pb";
import { LongPollingPayloadSchema, type IncomingRPCMessage } from "@/gen/gmproto/rpc_pb";

import { AuthData } from "./auth-data";
import { configVersion, RECEIVE_MESSAGES_URL, RECEIVE_MESSAGES_URL_GOOGLE } from "./constants";
import type { GMLogger } from "./logger";
import { Pblite, type PbliteDecodeError } from "./pblite";

// libgm longpoll.go: the ReceiveMessages request and its response stream.
//
// The response body is one JSON value written incrementally:
//   "[[" element ("," element)* "]]"
// where each element is a pblite LongPollingPayload array. Chunks arrive at
// arbitrary byte boundaries (inside strings, escapes or multi-byte UTF-8), so
// the parser tracks string/escape state and bracket depth per byte instead of
// libgm's trial json.Valid on accumulated chunks. Structural bytes are ASCII
// and never occur inside a UTF-8 multi-byte sequence, so scanning bytes is
// safe; each complete element is decoded as UTF-8 once.

export type LongPollFrame =
  | { readonly kind: "data"; readonly message: IncomingRPCMessage }
  | { readonly kind: "ack"; readonly count: number }
  | { readonly kind: "startRead" }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "unknown" }
  | { readonly kind: "invalid"; readonly error: PbliteDecodeError };

export type LongPollEvent =
  | { readonly kind: "opened" }
  | { readonly kind: "frame"; readonly frame: LongPollFrame }
  | { readonly kind: "ended" }
  | { readonly kind: "trailingData" };

export class LongPollFormatError extends TaggedError("LongPollFormatError")<{
  message: string;
}> {}

/** Elements larger than this are rejected rather than buffered without bound. */
export const MAX_ELEMENT_BYTES = 64 * 1024 * 1024;

const OPEN = 0x5b; // [
const CLOSE = 0x5d; // ]
const COMMA = 0x2c;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** libgm readLongPoll's switch: data, then ack, then startRead, then heartbeat. */
const decodeFrame = (text: string): LongPollFrame => {
  const decoded = Pblite.unmarshal(LongPollingPayloadSchema, text);
  if (decoded.isErr()) return { kind: "invalid", error: decoded.error };
  const payload = decoded.value;
  if (payload.data !== undefined) return { kind: "data", message: payload.data };
  if (payload.ack !== undefined) return { kind: "ack", count: payload.ack.count ?? 0 };
  if (payload.startRead !== undefined) return { kind: "startRead" };
  if (payload.heartbeat !== undefined) return { kind: "heartbeat" };
  return { kind: "unknown" };
};

type ParserState =
  | { kind: "prefix"; opened: number }
  | { kind: "between"; sawElement: boolean; needComma: boolean }
  | { kind: "element"; depth: number; inString: boolean; escape: boolean }
  | { kind: "closing" }
  | { kind: "ended" };

export type LongPollParser = {
  /** Feeds bytes; returns the events they complete. */
  push(chunk: Uint8Array): Result<LongPollEvent[], LongPollFormatError>;
  /** Whether "]]" was seen. */
  readonly ended: () => boolean;
  /** Whether "[[" was seen. */
  readonly opened: () => boolean;
};

const formatError = (message: string): Result<never, LongPollFormatError> =>
  Result.err(
    new LongPollFormatError({
      message: `Google Messages long poll stream is malformed: ${message}. The stream was dropped and will be reopened.`,
    }),
  );

const concat = (parts: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const createParser = (): LongPollParser => {
  let state: ParserState = { kind: "prefix", opened: 0 };
  let parts: Uint8Array[] = [];
  let partsBytes = 0;
  let wasOpened = false;

  const push = (chunk: Uint8Array): Result<LongPollEvent[], LongPollFormatError> => {
    const events: LongPollEvent[] = [];
    let elementStart = state.kind === "element" ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] ?? 0;
      switch (state.kind) {
        case "prefix":
          if (state.opened === 0 && isSpace(b)) continue;
          if (b !== OPEN) return formatError(`it does not start with "[[" (byte ${state.opened} is 0x${b.toString(16)})`);
          if (state.opened === 0) {
            state = { kind: "prefix", opened: 1 };
          } else {
            state = { kind: "between", sawElement: false, needComma: false };
            wasOpened = true;
            events.push({ kind: "opened" });
          }
          continue;
        case "between":
          if (isSpace(b)) continue;
          if (b === COMMA) {
            if (!state.needComma) return formatError("it has a stray comma between frames");
            state = { kind: "between", sawElement: true, needComma: false };
            continue;
          }
          if (b === OPEN) {
            if (state.needComma) return formatError("two frames are not separated by a comma");
            state = { kind: "element", depth: 1, inString: false, escape: false };
            elementStart = i;
            continue;
          }
          if (b === CLOSE) {
            state = { kind: "closing" };
            continue;
          }
          return formatError(`it has an unexpected byte 0x${b.toString(16)} between frames`);
        case "closing":
          if (b !== CLOSE) return formatError(`its end marker is not "]]"`);
          state = { kind: "ended" };
          events.push({ kind: "ended" });
          continue;
        case "ended":
          if (!isSpace(b)) {
            events.push({ kind: "trailingData" });
            return Result.ok(events);
          }
          continue;
        case "element": {
          if (state.inString) {
            if (state.escape) state.escape = false;
            else if (b === BACKSLASH) state.escape = true;
            else if (b === QUOTE) state.inString = false;
            continue;
          }
          if (b === QUOTE) state.inString = true;
          else if (b === OPEN) state.depth++;
          else if (b === CLOSE) {
            state.depth--;
            if (state.depth === 0) {
              const tail = chunk.subarray(Math.max(elementStart, 0), i + 1);
              const bytes = parts.length === 0 ? tail : concat([...parts, tail], partsBytes + tail.length);
              parts = [];
              partsBytes = 0;
              elementStart = -1;
              state = { kind: "between", sawElement: true, needComma: true };
              events.push({ kind: "frame", frame: decodeFrame(utf8.decode(bytes)) });
            }
          }
          continue;
        }
      }
    }
    if (state.kind === "element" && elementStart >= 0) {
      const rest = chunk.subarray(elementStart);
      partsBytes += rest.length;
      if (partsBytes > MAX_ELEMENT_BYTES) return formatError(`a frame exceeds ${MAX_ELEMENT_BYTES} bytes`);
      parts.push(new Uint8Array(rest));
    }
    return Result.ok(events);
  };

  return { push, ended: () => state.kind === "ended", opened: () => wasOpened };
};

export type StreamOutcome =
  /** The body ended. `opened`: "[[" was read; `ended`: the "]]" end marker was read. */
  | { readonly kind: "eof"; readonly opened: boolean; readonly ended: boolean; readonly frames: number }
  | { readonly kind: "malformed"; readonly error: LongPollFormatError; readonly frames: number }
  /** Reading failed (network error or our own abort). */
  | { readonly kind: "readError"; readonly cause: unknown; readonly opened: boolean; readonly frames: number };

/**
 * Reads a ReceiveMessages body to its end, calling `onFrame` for each frame
 * and `onOpened` once "[[" arrives. Never rejects. Aborting `signal` cancels
 * the reader.
 */
const consume = async (
  body: ReadableStream<Uint8Array>,
  handlers: { readonly onOpened: () => void; readonly onFrame: (frame: LongPollFrame) => void; readonly logger: GMLogger },
  signal?: AbortSignal,
): Promise<StreamOutcome> => {
  const parser = createParser();
  const reader = body.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let frames = 0;
  try {
    for (;;) {
      if (signal?.aborted) return { kind: "readError", cause: signal.reason, opened: parser.opened(), frames };
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (cause) {
        return { kind: "readError", cause, opened: parser.opened(), frames };
      }
      if (next.done) return { kind: "eof", opened: parser.opened(), ended: parser.ended(), frames };
      const pushed = parser.push(next.value);
      if (pushed.isErr()) {
        cancel();
        return { kind: "malformed", error: pushed.error, frames };
      }
      for (const event of pushed.value) {
        if (event.kind === "opened") handlers.onOpened();
        else if (event.kind === "frame") {
          frames++;
          handlers.onFrame(event.frame);
        } else if (event.kind === "trailingData") {
          handlers.logger.warn("long poll sent data after its end marker; ignoring it");
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};

export const LongPoll = {
  createParser,
  decodeFrame,
  consume,

  /** libgm doLongPoll's ReceiveMessagesRequest. */
  buildRequest(authData: AuthData, listenRequestId: string): ReceiveMessagesRequest {
    return create(ReceiveMessagesRequestSchema, {
      auth: {
        requestID: listenRequestId,
        tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
        network: AuthData.authNetwork(authData),
        configVersion: configVersion(),
      },
      unknown: { unknown: {} },
    });
  },

  url(authData: AuthData): string {
    return AuthData.hasCookies(authData) ? RECEIVE_MESSAGES_URL_GOOGLE : RECEIVE_MESSAGES_URL;
  },
} as const;

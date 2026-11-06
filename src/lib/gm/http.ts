import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { Result } from "better-result";

import { ErrorResponseSchema } from "@/gen/gmproto/authentication_pb";

import type { AuthData } from "./auth-data";
import { Clock } from "./clock";
import { CONTENT_TYPE_PBLITE, CONTENT_TYPE_PROTOBUF, MESSAGES_BASE_URL, relayHeaders } from "./constants";
import { sapisidHash } from "./crypto/sapisid";
import {
  GMAbortedError,
  GMDecodeError,
  GMHttpError,
  GMNetworkError,
  GMRequestError,
  type GMTransportError,
} from "./errors";
import type { GMLogger } from "./logger";
import { Pblite } from "./pblite";

// libgm http.go: protobuf/pblite POSTs with relay headers, cookie auth for
// Google-account sessions, Set-Cookie rotation, and typed response decoding.

/** The fetch signature the protocol layer needs (Bun's `typeof fetch` is assignable). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ContentType = typeof CONTENT_TYPE_PROTOBUF | typeof CONTENT_TYPE_PBLITE;

export type HttpContext = {
  readonly fetch: FetchFn;
  /** Cookies are read from and Set-Cookie updates written into this object. */
  readonly authData: AuthData;
  readonly logger: GMLogger;
  readonly clock: Clock;
  /** Called once per response whose Set-Cookie changed a stored cookie value. */
  readonly onCookiesChanged: () => void;
};

export type HttpRequest = {
  readonly url: string;
  /** Operation name for errors and logs, e.g. "SEND_MESSAGE" or "refreshing token". */
  readonly action: string;
  readonly contentType: ContentType;
  readonly body: Uint8Array | string;
  readonly signal?: AbortSignal;
  /** Whole-request timeout (headers and body). Default 30 s. */
  readonly timeoutMs?: number;
};

export type HttpResponse = {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
};

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** libgm's transport ResponseHeaderTimeout, used for the long poll's headers. */
export const STREAM_HEADERS_TIMEOUT_MS = 20_000;

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

// ---- Cookies (Go net/http AddCookie / readSetCookies) ----

const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const validCookieValueChar = (c: number): boolean => c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x3b && c !== 0x5c;

/** Go sanitizeCookieValue: drops invalid bytes and quotes values with a space or comma. */
const sanitizeCookieValue = (value: string): string => {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (validCookieValueChar(value.charCodeAt(i))) out += value.charAt(i);
  }
  return out.includes(" ") || out.includes(",") ? `"${out}"` : out;
};

/**
 * Cookies whose names are not RFC 6265 tokens (only possible from a pasted
 * JSON object) are left out: Headers rejects some of them, and Node's error
 * message quotes the whole Cookie header, secrets included.
 */
const cookieHeader = (cookies: Record<string, string>): string =>
  Object.entries(cookies)
    .filter(([name]) => TOKEN_CHAR.test(name))
    .map(([name, value]) => `${name}=${sanitizeCookieValue(value)}`)
    .join("; ");

/** Name and value of one Set-Cookie line, or undefined if Go would reject it. */
const parseSetCookie = (line: string): { name: string; value: string } | undefined => {
  const first = line.trim().split(";")[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq < 0) return undefined;
  const name = first.slice(0, eq).trim();
  if (!TOKEN_CHAR.test(name)) return undefined;
  const raw = first.slice(eq + 1);
  const value = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  for (let i = 0; i < value.length; i++) {
    if (!validCookieValueChar(value.charCodeAt(i))) return undefined;
  }
  return { name, value };
};

/**
 * libgm UpdateCookiesFromResponse: when the session has a cookie map, store
 * every Set-Cookie value. Returns the names whose value changed.
 */
const applySetCookies = (authData: AuthData, headers: Headers): string[] => {
  const cookies = authData.cookies;
  if (cookies === null) return [];
  const changed: string[] = [];
  for (const line of headers.getSetCookie()) {
    const parsed = parseSetCookie(line);
    if (parsed === undefined) continue;
    if (cookies[parsed.name] !== parsed.value) {
      cookies[parsed.name] = parsed.value;
      if (!changed.includes(parsed.name)) changed.push(parsed.name);
    }
  }
  return changed;
};

/** libgm BuildRelayHeaders + AddCookiesToRequest. */
const buildHeaders = (contentType: ContentType | undefined, cookies: Record<string, string> | null, now: Date): Headers => {
  const headers = new Headers(relayHeaders(contentType, "*/*"));
  if (cookies !== null) {
    const header = cookieHeader(cookies);
    if (header !== "") headers.set("cookie", header);
    const sapisid = cookies.SAPISID;
    if (sapisid !== undefined) {
      headers.set("authorization", sapisidHash(MESSAGES_BASE_URL, sapisid, Math.floor(now.getTime() / 1000)));
    }
  }
  return headers;
};

// ---- Requests ----

const statusHint = (status: number): string => {
  if (status === 401 || status === 403) {
    return "Google rejected the session's credentials, so the phone (or the Google account cookies) may need to be paired again";
  }
  if (status === 429) return "Google is rate limiting these requests; wait a minute before trying again";
  if (status >= 500) return "Google's servers failed to handle it; try again shortly";
  return "this may be a Google protocol change; try again, and re-pair if it keeps happening";
};

const httpError = (status: number, action: string): GMHttpError =>
  new GMHttpError({
    status,
    action,
    message: `Google Messages answered HTTP ${status} while ${action}. The request had no effect: ${statusHint(status)}.`,
  });

const networkError = (action: string, cause: unknown, timedOutAfterMs: number | null): GMNetworkError =>
  timedOutAfterMs !== null
    ? new GMNetworkError({
        action,
        reason: "timeout",
        message: `Google Messages did not answer within ${Math.round(timedOutAfterMs / 1000)} s while ${action}; the network or Google may be slow. Nothing on the phone changed unless Google had already accepted the request; try again.`,
        cause,
      })
    : new GMNetworkError({
        action,
        reason: "network",
        message: `Could not reach Google Messages while ${action} (network error). Nothing was sent; check connectivity and try again.`,
        cause,
      });

const abortedError = (action: string): GMAbortedError =>
  new GMAbortedError({ action, message: `Stopped ${action} because the caller cancelled the operation.` });

type Prepared = {
  readonly controller: AbortController;
  readonly timedOut: () => boolean;
  readonly release: () => void;
};

/** Links the caller's signal and a timeout to one AbortController. */
const prepareAbort = (clock: Clock, timeoutMs: number, signal: AbortSignal | undefined): Prepared => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let released = false;
  return {
    controller,
    timedOut: () => timedOut,
    release: () => {
      if (released) return;
      released = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

const sendInit = (ctx: HttpContext, req: HttpRequest, signal: AbortSignal): RequestInit => ({
  method: "POST",
  headers: buildHeaders(req.contentType, ctx.authData.cookies, ctx.clock.now()),
  body: typeof req.body === "string" ? req.body : new Uint8Array(req.body),
  signal,
});

const noteCookies = (ctx: HttpContext, response: Response, action: string): void => {
  const changed = applySetCookies(ctx.authData, response.headers);
  if (changed.length === 0) return;
  ctx.logger.debug("google rotated session cookies", { action, cookies: changed.join(",") });
  ctx.onCookiesChanged();
};

/** POST and read the whole body. Non-2xx statuses are returned, not errors. */
const post = async (ctx: HttpContext, req: HttpRequest): Promise<Result<HttpResponse, GMNetworkError | GMAbortedError>> => {
  const timeoutMs = req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (req.signal?.aborted) return Result.err(abortedError(req.action));
  const abort = prepareAbort(ctx.clock, timeoutMs, req.signal);
  try {
    const response = await ctx.fetch(req.url, sendInit(ctx, req, abort.controller.signal));
    noteCookies(ctx, response, req.action);
    const body = new Uint8Array(await response.arrayBuffer());
    return Result.ok({ status: response.status, contentType: response.headers.get("content-type") ?? "", body });
  } catch (cause) {
    if (req.signal?.aborted) return Result.err(abortedError(req.action));
    return Result.err(networkError(req.action, cause, abort.timedOut() ? timeoutMs : null));
  } finally {
    abort.release();
  }
};

export type OpenedStream = {
  readonly response: Response;
  /** Aborts the request (and its body stream). */
  readonly abort: () => void;
};

/**
 * POST for a streaming response (the long poll): the timeout covers only the
 * response headers. The caller reads `response.body` and must call `abort()`
 * when done with it.
 */
const openStream = async (
  ctx: HttpContext,
  req: Omit<HttpRequest, "timeoutMs"> & { readonly headersTimeoutMs?: number },
): Promise<Result<OpenedStream, GMNetworkError | GMAbortedError>> => {
  const timeoutMs = req.headersTimeoutMs ?? STREAM_HEADERS_TIMEOUT_MS;
  if (req.signal?.aborted) return Result.err(abortedError(req.action));
  const abort = prepareAbort(ctx.clock, timeoutMs, req.signal);
  try {
    const response = await ctx.fetch(req.url, sendInit(ctx, req, abort.controller.signal));
    abort.release();
    // From here the caller's signal (not the headers timeout) bounds the body.
    const onAbort = (): void => abort.controller.abort();
    if (req.signal?.aborted) abort.controller.abort();
    else req.signal?.addEventListener("abort", onAbort, { once: true });
    noteCookies(ctx, response, req.action);
    return Result.ok({
      response,
      abort: () => {
        req.signal?.removeEventListener("abort", onAbort);
        abort.controller.abort();
      },
    });
  } catch (cause) {
    const timedOut = abort.timedOut();
    abort.release();
    if (req.signal?.aborted) return Result.err(abortedError(req.action));
    return Result.err(networkError(req.action, cause, timedOut ? timeoutMs : null));
  }
};

const decodeBody = <Desc extends DescMessage>(
  schema: Desc,
  body: Uint8Array,
  contentTypeHeader: string,
  action: string,
): Result<MessageShape<Desc>, GMDecodeError> => {
  const mediaType = (contentTypeHeader.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === CONTENT_TYPE_PROTOBUF) {
    try {
      return Result.ok(fromBinary(schema, body));
    } catch (cause) {
      return Result.err(
        new GMDecodeError({
          action,
          message: `Google Messages sent a ${schema.typeName} response while ${action} that is not valid protobuf; this may be a protocol change. Nothing was stored.`,
          cause,
        }),
      );
    }
  }
  if (mediaType === CONTENT_TYPE_PBLITE || mediaType === "text/plain") {
    return Pblite.unmarshal(schema, utf8.decode(body)).mapError(
      (cause) =>
        new GMDecodeError({
          action,
          message: `Google Messages sent a ${schema.typeName} response while ${action} that does not match the expected pblite layout (${cause.message}); this may be a protocol change. Nothing was stored.`,
          cause,
        }),
    );
  }
  return Result.err(
    new GMDecodeError({
      action,
      message: `Google Messages answered ${action} with content type "${mediaType || "(none)"}", which is neither protobuf nor pblite; the response was ignored.`,
    }),
  );
};

/** libgm typedHTTPResponse: non-2xx -> GMRequestError (ErrorResponse with a message) or GMHttpError. */
const decodeTyped = <Desc extends DescMessage>(
  schema: Desc,
  res: HttpResponse,
  action: string,
): Result<MessageShape<Desc>, GMHttpError | GMRequestError | GMDecodeError> => {
  if (res.status < 200 || res.status >= 300) {
    const decoded = decodeBody(ErrorResponseSchema, res.body, res.contentType, action);
    if (decoded.isOk() && decoded.value.message !== "") {
      const errorType = decoded.value.type.toString();
      return Result.err(
        new GMRequestError({
          status: res.status,
          action,
          errorType,
          googleMessage: decoded.value.message,
          message: `Google Messages refused ${action} with HTTP ${res.status} (error ${errorType}: ${decoded.value.message}). The request had no effect: ${statusHint(res.status)}.`,
        }),
      );
    }
    return Result.err(httpError(res.status, action));
  }
  return decodeBody(schema, res.body, res.contentType, action);
};

const encodeBody = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  contentType: ContentType,
): Uint8Array | string => (contentType === CONTENT_TYPE_PROTOBUF ? toBinary(schema, message) : Pblite.marshal(schema, message));

/** POST `message` and decode the response as `responseSchema`. */
const request = async <Req extends DescMessage, Res extends DescMessage>(
  ctx: HttpContext,
  opts: {
    readonly url: string;
    readonly action: string;
    readonly contentType: ContentType;
    readonly requestSchema: Req;
    readonly message: MessageShape<Req>;
    readonly responseSchema: Res;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<Result<MessageShape<Res>, GMTransportError>> => {
  const res = await post(ctx, {
    url: opts.url,
    action: opts.action,
    contentType: opts.contentType,
    body: encodeBody(opts.requestSchema, opts.message, opts.contentType),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (res.isErr()) return Result.err(res.error);
  return decodeTyped(opts.responseSchema, res.value, opts.action);
};

export const GMHttp = {
  buildHeaders,
  applySetCookies,
  encodeBody,
  post,
  openStream,
  decodeBody,
  decodeTyped,
  request,
  httpError,
} as const;

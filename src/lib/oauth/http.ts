import { Result } from "better-result";
import { OAuthErrors, type OAuthProtocolError } from "./errors";

/** Request bodies above this are rejected before parsing (DCR documents and token forms are tiny). */
const MAX_BODY_BYTES = 64 * 1024;

/** CORS for public OAuth endpoints: any origin, no credentials. */
const corsHeaders: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After",
};

const noStore: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

const json = (
  body: unknown,
  init: { status?: number; headers?: Readonly<Record<string, string>>; cors?: boolean } = {},
): Response =>
  Response.json(body, {
    status: init.status ?? 200,
    headers: { ...noStore, ...(init.cors === false ? {} : corsHeaders), ...init.headers },
  });

const protocolError = (error: OAuthProtocolError, cors = true): Response =>
  json(
    { error: error.error, error_description: error.description },
    { status: error.status, headers: error.headers, cors },
  );

/** 204 answer to a CORS preflight for the given methods. */
const preflight = (methods: string): Response =>
  new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });

const readBody = async (request: Request): Promise<Result<string, OAuthProtocolError>> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return Result.err(OAuthErrors.protocol(413, "invalid_request", "The request body is too large."));
  }
  const text = await Result.tryPromise({
    try: () => request.text(),
    catch: () => OAuthErrors.protocol(400, "invalid_request", "The request body could not be read."),
  });
  if (text.isErr()) return text;
  if (Buffer.byteLength(text.value) > MAX_BODY_BYTES) {
    return Result.err(OAuthErrors.protocol(413, "invalid_request", "The request body is too large."));
  }
  return Result.ok(text.value);
};

const mediaType = (request: Request): string =>
  (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * Parses an application/x-www-form-urlencoded body. Parameters must not
 * repeat (RFC 6749 section 3.1); empty values count as absent.
 */
const readForm = async (
  request: Request,
): Promise<Result<ReadonlyMap<string, string>, OAuthProtocolError>> => {
  if (mediaType(request) !== "application/x-www-form-urlencoded") {
    return Result.err(
      OAuthErrors.protocol(
        400,
        "invalid_request",
        "Send the request as application/x-www-form-urlencoded.",
      ),
    );
  }
  const body = await readBody(request);
  if (body.isErr()) return Result.err(body.error);
  return uniqueParams(new URLSearchParams(body.value));
};

const uniqueParams = (
  params: URLSearchParams,
): Result<ReadonlyMap<string, string>, OAuthProtocolError> => {
  const result = new Map<string, string>();
  for (const [key, value] of params) {
    if (result.has(key)) {
      return Result.err(
        OAuthErrors.protocol(400, "invalid_request", `The "${key}" parameter must not be repeated.`),
      );
    }
    if (value !== "") result.set(key, value);
  }
  return Result.ok(result);
};

/** Parses a JSON object body (RFC 7591 registration). */
const readJsonObject = async (
  request: Request,
): Promise<Result<Readonly<Record<string, unknown>>, OAuthProtocolError>> => {
  if (mediaType(request) !== "application/json") {
    return Result.err(
      OAuthErrors.protocol(400, "invalid_client_metadata", "Send the registration as application/json."),
    );
  }
  const body = await readBody(request);
  if (body.isErr()) return Result.err(body.error);
  const parsed = Result.try({
    try: (): unknown => JSON.parse(body.value),
    catch: () =>
      OAuthErrors.protocol(400, "invalid_client_metadata", "The request body is not valid JSON."),
  });
  if (parsed.isErr()) return Result.err(parsed.error);
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.err(
      OAuthErrors.protocol(400, "invalid_client_metadata", "The request body must be a JSON object."),
    );
  }
  return Result.ok(Object.fromEntries(Object.entries(value)));
};

const hextet = /^[0-9a-f]{1,4}$/i;

/**
 * Throttle bucket of an address: an IPv6 address counts as its /64 (one
 * subscriber usually controls a whole /64, so per-address buckets are free to
 * multiply), an IPv4-mapped IPv6 address as its IPv4 address, anything else
 * as itself.
 */
const throttleBucket = (address: string): string => {
  if (!address.includes(":")) return address;
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped?.[1] !== undefined) return mapped[1];
  const halves = bare.split("::");
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const width = (parts: readonly string[]) => parts.reduce((n, part) => n + (part.includes(".") ? 2 : 1), 0);
  const zeros = 8 - width(head) - width(tail);
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return address;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? zeros : 0 }, () => "0"), ...tail];
  const prefix = groups.slice(0, 4);
  if (!prefix.every((group) => hextet.test(group))) return address;
  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
};

/**
 * Best-effort client address for throttling (see `throttleBucket`). On
 * Vercel `x-forwarded-for` is set by the platform; elsewhere it may be
 * absent, so everything unknown shares one bucket.
 */
const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return throttleBucket(forwarded);
  const real = request.headers.get("x-real-ip")?.trim();
  return real ? throttleBucket(real) : "unknown";
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * A minimal standalone HTML error page for endpoints that must not redirect
 * (e.g. an unknown client or redirect URI on /oauth/authorize). Inline styles
 * mirror the app's palette.
 */
const htmlError = (status: number, title: string, message: string): Response =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · openrcs</title>
<style>
:root{--bg:#f6f6f3;--surface:#fff;--fg:#1d1d1b;--muted:#66665f;--border:#e2e2dc;--accent:#2c6a59}
@media (prefers-color-scheme:dark){:root{--bg:#121311;--surface:#1a1b19;--fg:#ebebe6;--muted:#9c9c94;--border:#2e2f2b;--accent:#6fbfa5}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.6 ui-sans-serif,system-ui,sans-serif;padding:48px 16px;box-sizing:border-box}
main{width:100%;max-width:384px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px;letter-spacing:-.01em}p{margin:0;color:var(--muted)}a{color:var(--accent)}
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

/** A 303 See Other to `location` (absolute or same-origin relative). */
const seeOther = (location: string, headers: Readonly<Record<string, string>> = {}): Response =>
  new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...headers } });

export const OAuthHttp = {
  corsHeaders,
  json,
  protocolError,
  preflight,
  readForm,
  readJsonObject,
  uniqueParams,
  throttleBucket,
  clientIp,
  escapeHtml,
  htmlError,
  seeOther,
} as const;

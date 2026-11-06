import { Result, TaggedError } from "better-result";

/** A redirect URI (or client/logo URI) failed registration rules. `reason` is safe to show. */
export class InvalidRedirectUriError extends TaggedError("InvalidRedirectUriError")<{
  reason: string;
  message: string;
}> {}

/** Real redirect, client and logo URIs are far shorter; the cap bounds what open registration can store. */
export const MAX_URI_LENGTH = 512;

/** Schemes that are never private-use app schemes (RFC 8252 section 7.1). */
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "filesystem:",
  "ftp:",
  "ws:",
  "wss:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const hasControlOrSpace = (value: string): boolean =>
  /\s/.test(value) ||
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const authorityWithUserinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

const reject = (reason: string) =>
  Result.err(new InvalidRedirectUriError({ reason, message: `Invalid redirect URI: ${reason}.` }));

/**
 * Parses a URI string common to every rule: bounded length, no whitespace,
 * no fragment, no userinfo, absolute.
 */
const parseCommon = (
  value: unknown,
): Result<{ readonly url: URL; readonly raw: string }, InvalidRedirectUriError> => {
  if (typeof value !== "string" || value.length === 0) return reject("must be a non-empty string");
  if (value.length > MAX_URI_LENGTH) return reject(`must be at most ${MAX_URI_LENGTH} characters`);
  if (hasControlOrSpace(value)) return reject("must not contain whitespace or control characters");
  if (value.includes("#")) return reject("must not contain a fragment (#)");
  if (authorityWithUserinfo.test(value)) return reject("must not contain user information (user@host)");
  if (!URL.canParse(value)) return reject("must be an absolute URI");
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    return reject("must not contain user information (user@host)");
  }
  return Result.ok({ url, raw: value });
};

const isLoopbackHttp = (url: URL) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

/**
 * RFC 7591 / OAuth 2.1 redirect URI rules: https on any host; http only on
 * loopback hosts (native apps); private-use custom schemes for native apps,
 * except script, data, file and other non-app schemes.
 */
const validate = (value: unknown): Result<string, InvalidRedirectUriError> => {
  const parsed = parseCommon(value);
  if (parsed.isErr()) return Result.err(parsed.error);
  const { url, raw } = parsed.value;
  if (BLOCKED_SCHEMES.has(url.protocol)) return reject(`the ${url.protocol} scheme is not allowed`);
  if (url.protocol === "https:") {
    if (url.hostname === "") return reject("https URIs need a host");
  } else if (url.protocol === "http:") {
    if (!isLoopbackHttp(url)) {
      return reject("http is only allowed for loopback hosts (127.0.0.1, [::1], localhost); use https");
    }
  } else if (url.href.length <= url.protocol.length) {
    return reject("custom-scheme URIs need a path");
  }
  return Result.ok(raw);
};

/** Informational client URIs (client_uri, logo_uri): https, or http on loopback. */
const validateWebUri = (value: unknown): Result<string, InvalidRedirectUriError> => {
  const parsed = parseCommon(value);
  if (parsed.isErr()) return Result.err(parsed.error);
  const { url, raw } = parsed.value;
  if (url.protocol === "https:" || isLoopbackHttp(url)) return Result.ok(raw);
  return reject("must be an https URI");
};

export const RedirectUri = {
  validate,
  validateWebUri,
  isLoopbackHttp,
} as const;

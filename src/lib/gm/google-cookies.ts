import { Result, TaggedError } from "better-result";

// Google account cookies for Gaia pairing, pasted by the user. Port of
// openmessage cmd/pair.go parseGoogleCookiesInput (JSON object, curl command,
// or raw Cookie header) with a fuller curl parser: bash single quotes, $'..'
// ANSI-C quotes, double quotes, backslash line continuations, Windows cmd ^
// escaping (DevTools "Copy as cURL (cmd)"), -H/--header and -b/--cookie.

export type GoogleCookies = Record<string, string>;

export const REQUIRED_GOOGLE_COOKIES = ["SID", "HSID", "SSID", "APISID", "SAPISID"] as const;

export class GoogleCookiesParseError extends TaggedError("GoogleCookiesParseError")<{
  reason: "empty" | "invalidJson" | "invalidCurl" | "noCookies" | "missingRequired";
  /** Names of required cookies that were not found (never values). */
  missing: string[];
  message: string;
}> {}

const HOW_TO =
  "Copy the cookies from a signed-in messages.google.com tab: in DevTools > Network, right-click a request to messages.google.com and choose Copy > Copy as cURL, then paste the whole command.";

const fail = (
  reason: GoogleCookiesParseError["reason"],
  message: string,
  missing: string[] = [],
): Result<never, GoogleCookiesParseError> =>
  Result.err(new GoogleCookiesParseError({ reason, missing, message: `${message} ${HOW_TO}` }));

// ---- Cookie header (Go net/http readCookies) ----

const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const parseCookieValue = (raw: string): string | undefined => {
  const value = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c >= 0x7f || c === 0x22 || c === 0x3b || c === 0x5c) return undefined;
  }
  return value;
};

/** Parses a Cookie header value (optionally prefixed with "Cookie:"); invalid pairs are skipped as Go does. */
const parseCookieHeader = (header: string, into: GoogleCookies): void => {
  let line = header.trim();
  if (line.toLowerCase().startsWith("cookie:")) line = line.slice("cookie:".length).trim();
  for (const rawPart of line.split(";")) {
    const part = rawPart.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!TOKEN_CHAR.test(name)) continue;
    const value = parseCookieValue(eq < 0 ? "" : part.slice(eq + 1));
    if (value === undefined) continue;
    into[name] = value;
  }
};

// ---- Shell splitting ----

const ANSI_C_SIMPLE: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  a: "\x07",
  b: "\b",
  f: "\f",
  e: "\x1b",
  E: "\x1b",
  "?": "?",
  "'": "'",
  '"': '"',
  "\\": "\\",
};

/** Reads a $'...' body starting after the opening quote; returns the text and the index after the closing quote. */
const readAnsiC = (input: string, start: number): { text: string; end: number } | undefined => {
  let out = "";
  let i = start;
  while (i < input.length) {
    const c = input.charAt(i);
    if (c === "'") return { text: out, end: i + 1 };
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const next = input.charAt(i + 1);
    const simple = ANSI_C_SIMPLE[next];
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    const hex = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
    if (hex > 0) {
      const digits = /^[0-9A-Fa-f]+/.exec(input.slice(i + 2, i + 2 + hex))?.[0] ?? "";
      if (digits === "") {
        out += `\\${next}`;
        i += 2;
        continue;
      }
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      i += 2 + digits.length;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(input.slice(i + 1, i + 4))?.[0];
    if (octal !== undefined) {
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      i += 1 + octal.length;
      continue;
    }
    if (next === "c" && i + 2 < input.length) {
      out += String.fromCharCode(input.charCodeAt(i + 2) & 0x1f);
      i += 3;
      continue;
    }
    out += `\\${next}`;
    i += 2;
  }
  return undefined;
};

const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/** Splits a POSIX-shell command line into words. Returns undefined on an unterminated quote. */
const shellSplit = (input: string): string[] | undefined => {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const flush = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  while (i < input.length) {
    const c = input.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      i++;
    } else if (c === "\\") {
      const next = input.charAt(i + 1);
      if (next === "\n") {
        i += 2;
      } else if (next === "\r" && input.charAt(i + 2) === "\n") {
        i += 3;
      } else {
        word += next;
        inWord = true;
        i += 2;
      }
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === "$" && input.charAt(i + 1) === "'") {
      const read = readAnsiC(input, i + 2);
      if (read === undefined) return undefined;
      word += read.text;
      inWord = true;
      i = read.end;
    } else if (c === '"') {
      i++;
      inWord = true;
      let closed = false;
      while (i < input.length) {
        const d = input.charAt(i);
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\") {
          const next = input.charAt(i + 1);
          if (next === "\n") {
            i += 2;
            continue;
          }
          if (DOUBLE_QUOTE_ESCAPABLE.has(next)) {
            word += next;
            i += 2;
            continue;
          }
        }
        word += d;
        i++;
      }
      if (!closed) return undefined;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return words;
};

/**
 * DevTools "Copy as cURL (cmd)" wraps every argument in ^"...^", caret-escapes
 * special characters and continues lines with a trailing ^. Undoing the cmd.exe
 * layer leaves MS CRT double-quoting (\" and \\), which shellSplit understands.
 */
const isCmdStyle = (input: string): boolean => /(^|\s)\^"/.test(input);

const undoCmdEscaping = (input: string): string => input.replace(/\^\r?\n/g, "").replace(/\^([\s\S])/g, "$1");

// curl options whose argument is the next word; skipped so their values are not read as options.
const OPTIONS_WITH_ARGUMENT = new Set([
  "-X",
  "--request",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-o",
  "--output",
  "-u",
  "--user",
  "-x",
  "--proxy",
  "-F",
  "--form",
  "--url",
  "-m",
  "--max-time",
  "--connect-timeout",
]);

type CurlCookies = { readonly kind: "ok"; readonly cookieStrings: string[] } | { readonly kind: "error"; readonly message: string };

const cookieStringsFromCurl = (command: string): CurlCookies => {
  const words = shellSplit(isCmdStyle(command) ? undoCmdEscaping(command) : command);
  if (words === undefined) {
    return { kind: "error", message: "The curl command has an unterminated quote, so it could not be read; it may have been cut off when copying." };
  }
  const cookieStrings: string[] = [];
  const addHeader = (header: string): void => {
    const colon = header.indexOf(":");
    if (colon < 0) return;
    if (header.slice(0, colon).trim().toLowerCase() === "cookie") cookieStrings.push(header.slice(colon + 1));
  };
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? "";
    const next = words[i + 1];
    if (word === "-H" || word === "--header") {
      if (next !== undefined) addHeader(next);
      i++;
    } else if (word.startsWith("--header=")) {
      addHeader(word.slice("--header=".length));
    } else if (word.startsWith("-H") && word.length > 2) {
      addHeader(word.slice(2));
    } else if (word === "-b" || word === "--cookie") {
      if (next !== undefined) {
        if (!next.includes("=")) {
          return { kind: "error", message: "The curl command reads cookies from a file (-b <file>); paste a command that contains the cookie values instead." };
        }
        cookieStrings.push(next);
      }
      i++;
    } else if (word.startsWith("--cookie=")) {
      cookieStrings.push(word.slice("--cookie=".length));
    } else if (word.startsWith("-b") && word.length > 2) {
      cookieStrings.push(word.slice(2));
    } else if (OPTIONS_WITH_ARGUMENT.has(word)) {
      i++;
    }
  }
  return { kind: "ok", cookieStrings };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireCookies = (cookies: GoogleCookies): Result<GoogleCookies, GoogleCookiesParseError> => {
  if (Object.keys(cookies).length === 0) {
    return fail("noCookies", "No cookies were found in the pasted text.", [...REQUIRED_GOOGLE_COOKIES]);
  }
  const missing = REQUIRED_GOOGLE_COOKIES.filter((name) => (cookies[name] ?? "") === "");
  if (missing.length > 0) {
    return fail(
      "missingRequired",
      `The pasted cookies are missing ${missing.join(", ")}, which Google requires to sign in; copy them from a tab where you are signed in to the Google account your phone uses.`,
      missing,
    );
  }
  return Result.ok(cookies);
};

export const GoogleCookies = {
  /**
   * Accepts a JSON object, a `curl ...` command (Copy as cURL from DevTools,
   * bash or cmd quoting, -H 'cookie: ...' or -b '...'), or a raw Cookie header
   * (with or without a leading "Cookie:"). Requires SID, HSID, SSID, APISID,
   * SAPISID and keeps every other cookie. Error messages name missing cookie
   * names, never values.
   */
  parse(input: string): Result<GoogleCookies, GoogleCookiesParseError> {
    const trimmed = input.trim();
    if (trimmed === "") return fail("empty", "No cookies were provided.", [...REQUIRED_GOOGLE_COOKIES]);

    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return fail("invalidJson", "The pasted text starts with { but is not valid JSON.");
      }
      if (!isRecord(parsed)) return fail("invalidJson", "The pasted JSON is not an object of cookie names to values.");
      const cookies: GoogleCookies = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
          return fail("invalidJson", `The pasted JSON has a non-string value for cookie ${JSON.stringify(name)}; every value must be a string.`);
        }
        cookies[name] = value;
      }
      return requireCookies(cookies);
    }

    if (/^curl(\.exe)?\s/i.test(trimmed)) {
      const curl = cookieStringsFromCurl(trimmed);
      if (curl.kind === "error") return fail("invalidCurl", curl.message);
      if (curl.cookieStrings.length === 0) {
        return fail("noCookies", "The curl command has no Cookie header (-H 'cookie: ...' or -b '...').", [...REQUIRED_GOOGLE_COOKIES]);
      }
      const cookies: GoogleCookies = {};
      for (const header of curl.cookieStrings) parseCookieHeader(header, cookies);
      return requireCookies(cookies);
    }

    const cookies: GoogleCookies = {};
    parseCookieHeader(trimmed, cookies);
    return requireCookies(cookies);
  },
} as const;

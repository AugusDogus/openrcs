import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { createClient } from "@libsql/client";
import { Result, TaggedError } from "better-result";

import { REQUIRED_GOOGLE_COOKIES, type GoogleCookies } from "@/lib/gm/google-cookies";

// Reads the Google cookies of a Chromium profile from its `Cookies` SQLite
// file. Only for the pairing browser we launch ourselves with
// `--password-store=basic`: Chromium then encrypts values with a fixed key
// (components/os_crypt, Linux "v10": AES-128-CBC, key PBKDF2-SHA1 of
// "peanuts" with salt "saltysalt", 1 iteration, IV of 16 spaces). From cookie
// database version 24 the plaintext starts with SHA-256(host_key).

const V10_KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const V10_IV = Buffer.alloc(16, " ");
const HOST_HASH_BYTES = 32;
const HOST_HASH_DB_VERSION = 24;

/** Cookie hosts the browser would send to messages.google.com. */
const MESSAGES_HOSTS = [".google.com", "messages.google.com", ".messages.google.com"] as const;

/** Microseconds between 1601-01-01 (Chromium's epoch) and the Unix epoch. */
const WINDOWS_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;

export class ChromiumCookiesError extends TaggedError("ChromiumCookiesError")<{
  reason: "unreadable" | "decrypt";
  /** Cookie name when one value failed (never the value). */
  cookie: string | null;
  message: string;
  cause?: unknown;
}> {}

/** What the profile holds for messages.google.com. */
export type ChromiumGoogleCookies =
  | { readonly status: "signedIn"; readonly cookies: GoogleCookies }
  | { readonly status: "signedOut"; readonly missing: readonly string[] };

const decryptError = (cookie: string, detail: string, cause?: unknown) =>
  new ChromiumCookiesError({
    reason: "decrypt",
    cookie,
    message: `The pairing browser's cookie "${cookie}" could not be decrypted (${detail}). Nothing was used; close the sign-in window and start again.`,
    cause,
  });

/** Decrypt one `encrypted_value`. A plain `value` wins when it is set (unencrypted rows). */
const decryptValue = (
  row: { readonly name: string; readonly hostKey: string; readonly value: string; readonly encrypted: Uint8Array },
  dbVersion: number,
): Result<string, ChromiumCookiesError> => {
  if (row.encrypted.length === 0) return Result.ok(row.value);
  const data = Buffer.from(row.encrypted);
  const prefix = data.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") return Result.err(decryptError(row.name, `unsupported format "${prefix}"`));
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", V10_KEY, V10_IV);
    plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  } catch (cause) {
    return Result.err(decryptError(row.name, "bad padding", cause));
  }
  if (dbVersion >= HOST_HASH_DB_VERSION) {
    const expected = createHash("sha256").update(row.hostKey).digest();
    if (plain.length < HOST_HASH_BYTES || !plain.subarray(0, HOST_HASH_BYTES).equals(expected)) {
      return Result.err(decryptError(row.name, "the domain check failed"));
    }
    plain = plain.subarray(HOST_HASH_BYTES);
  }
  return Result.ok(plain.toString("utf8"));
};

const unreadable = (detail: string, cause?: unknown) =>
  new ChromiumCookiesError({
    reason: "unreadable",
    cookie: null,
    message: `openrcs could not read the pairing browser's cookies (${detail}). Nothing was used; close the sign-in window and start again.`,
    cause,
  });

const toBytes = (value: unknown): Uint8Array =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : new Uint8Array(0);

/** Chromium time (µs since 1601) to Unix ms; 0 means a session cookie. */
const expiresAtMs = (value: unknown): number | null => {
  const micros = typeof value === "bigint" ? value : typeof value === "number" ? BigInt(Math.trunc(value)) : 0n;
  return micros === 0n ? null : Number((micros - WINDOWS_EPOCH_OFFSET_MICROS) / 1000n);
};

/**
 * Read the cookies a browser with this profile would send to
 * messages.google.com. Works on a copy, so a running Chromium is not
 * disturbed; a missing database reads as signed out.
 */
const readGoogle = async (
  cookiesPath: string,
  opts: { readonly now?: number } = {},
): Promise<Result<ChromiumGoogleCookies, ChromiumCookiesError>> => {
  const dir = await Result.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "openrcs-cookies-")),
    catch: (cause) => unreadable("no temporary directory", cause),
  });
  if (dir.isErr()) return Result.err(dir.error);
  const copy = join(dir.value, "Cookies");
  try {
    try {
      await copyFile(cookiesPath, copy);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
        return Result.ok({ status: "signedOut", missing: [...REQUIRED_GOOGLE_COOKIES] });
      }
      return Result.err(unreadable("the cookie file could not be copied", cause));
    }
    // A hot rollback journal holds an unfinished write; SQLite rolls it back on open.
    await copyFile(`${cookiesPath}-journal`, `${copy}-journal`).catch(() => undefined);

    // expires_utc (µs since 1601) is beyond Number.MAX_SAFE_INTEGER.
    const client = createClient({ url: `file:${copy}`, intMode: "bigint" });
    try {
      const rows = await Result.tryPromise({
        try: async () => {
          const meta = await client.execute("SELECT value FROM meta WHERE key = 'version'");
          const cookies = await client.execute({
            sql: `SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies WHERE host_key IN (${MESSAGES_HOSTS.map(() => "?").join(", ")}) ORDER BY length(host_key), length(path) DESC`,
            args: [...MESSAGES_HOSTS],
          });
          return { version: Number(meta.rows[0]?.value ?? 0), cookies: cookies.rows };
        },
        catch: (cause) => unreadable("the cookie database did not open", cause),
      });
      if (rows.isErr()) return Result.err(rows.error);

      const now = opts.now ?? Date.now();
      const cookies: GoogleCookies = {};
      for (const row of rows.value.cookies) {
        const name = String(row.name);
        const expires = expiresAtMs(row.expires_utc);
        if (expires !== null && expires <= now) continue;
        // More specific hosts sort later and win, as in the browser's Cookie header.
        const value = decryptValue(
          { name, hostKey: String(row.host_key), value: String(row.value ?? ""), encrypted: toBytes(row.encrypted_value) },
          rows.value.version,
        );
        if (value.isErr()) return Result.err(value.error);
        cookies[name] = value.value;
      }
      const missing = REQUIRED_GOOGLE_COOKIES.filter((name) => !cookies[name]);
      return Result.ok(missing.length === 0 ? { status: "signedIn", cookies } : { status: "signedOut", missing });
    } finally {
      client.close();
    }
  } finally {
    await rm(dir.value, { recursive: true, force: true });
  }
};

export const ChromiumCookies = { decryptValue, readGoogle } as const;

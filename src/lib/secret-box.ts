import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { Result, TaggedError } from "better-result";
import { Env } from "@/lib/env";

/**
 * AES-256-GCM sealing of strings for secrets at rest (Google cookies, pairing
 * keys). Envelope format:
 *
 *   v1.<base64url iv (12 bytes)>.<base64url ciphertext || tag (16 bytes)>
 *
 * Optional associated data (e.g. the owning user id) is authenticated but not
 * stored, so an envelope copied to another user's row fails to open.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

/** The configured key is missing, not base64, or not 32 bytes. */
export class SecretBoxKeyError extends TaggedError("SecretBoxKeyError")<{
  message: string;
}> {}

/** The envelope is not a well-formed `v1` secret-box string. */
export class SecretBoxFormatError extends TaggedError("SecretBoxFormatError")<{
  reason: string;
  message: string;
}> {}

/**
 * Authentication failed: the envelope was sealed with a different key or
 * associated data, or it was modified after sealing.
 */
export class SecretBoxAuthError extends TaggedError("SecretBoxAuthError")<{
  message: string;
}> {}

export type SecretBoxOpenError = SecretBoxFormatError | SecretBoxAuthError;

export type SecretBox = { readonly key: KeyObject };

export type SecretBoxOptions = {
  /** Authenticated, unstored context such as the owning user id. */
  readonly associatedData?: string;
};

const formatError = (reason: string) =>
  new SecretBoxFormatError({
    reason,
    message: `Cannot open secret-box envelope: ${reason}. The stored value is unreadable as-is; re-create it (e.g. re-pair the phone).`,
  });

/**
 * Strict unpadded base64url: Node's decoder silently drops trailing characters
 * and non-zero padding bits, so require the canonical encoding to round-trip.
 */
const decodeBase64Url = (value: string): Uint8Array | undefined => {
  if (!base64UrlPattern.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? new Uint8Array(bytes) : undefined;
};

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const fromBase64Key = (keyBase64: string): Result<SecretBox, SecretBoxKeyError> => {
  const trimmed = keyBase64.trim();
  if (!base64Pattern.test(trimmed)) {
    return Result.err(
      new SecretBoxKeyError({
        message:
          "SESSION_ENCRYPTION_KEY is not valid base64. Generate a key with `openssl rand -base64 32`.",
      }),
    );
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.byteLength !== KEY_BYTES) {
    return Result.err(
      new SecretBoxKeyError({
        message: `SESSION_ENCRYPTION_KEY decodes to ${bytes.byteLength} bytes, expected ${KEY_BYTES}. Generate a key with \`openssl rand -base64 32\`.`,
      }),
    );
  }
  return Result.ok({ key: createSecretKey(bytes) });
};

let envBox: SecretBox | undefined;

/**
 * The secret box keyed by `SESSION_ENCRYPTION_KEY`. Throws `InvalidEnvError`
 * when the variable is missing or malformed (deployment misconfiguration).
 */
const fromEnv = (): SecretBox => {
  if (envBox) return envBox;
  const { SESSION_ENCRYPTION_KEY } = Env.secretBox();
  const box = fromBase64Key(SESSION_ENCRYPTION_KEY).match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
  envBox = box;
  return box;
};

const seal = (box: SecretBox, plaintext: string, options: SecretBoxOptions = {}): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", box.key, iv, { authTagLength: TAG_BYTES });
  if (options.associatedData !== undefined) {
    cipher.setAAD(utf8.encode(options.associatedData));
  }
  const ciphertext = Buffer.concat([cipher.update(utf8.encode(plaintext)), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
};

const open = (
  box: SecretBox,
  envelope: string,
  options: SecretBoxOptions = {},
): Result<string, SecretBoxOpenError> => {
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    return Result.err(formatError(`expected 3 dot-separated parts, got ${parts.length}`));
  }
  const [version, ivPart, sealedPart] = parts;
  if (version !== VERSION) {
    return Result.err(formatError(`unsupported version "${version}" (expected "${VERSION}")`));
  }
  const iv = decodeBase64Url(ivPart);
  if (!iv || iv.byteLength !== IV_BYTES) {
    return Result.err(formatError(`IV must be ${IV_BYTES} bytes of base64url`));
  }
  const sealed = decodeBase64Url(sealedPart);
  if (!sealed || sealed.byteLength < TAG_BYTES) {
    return Result.err(
      formatError(`ciphertext must be base64url of at least ${TAG_BYTES} bytes (the tag)`),
    );
  }
  const ciphertext = sealed.subarray(0, sealed.byteLength - TAG_BYTES);
  const tag = sealed.subarray(sealed.byteLength - TAG_BYTES);

  const decrypted = Result.try({
    try: () => {
      const decipher = createDecipheriv("aes-256-gcm", box.key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      if (options.associatedData !== undefined) {
        decipher.setAAD(utf8.encode(options.associatedData));
      }
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
    catch: () =>
      new SecretBoxAuthError({
        message:
          "Cannot open secret-box envelope: authentication failed (wrong SESSION_ENCRYPTION_KEY, wrong associated data, or the value was modified). The stored value was not changed.",
      }),
  });

  return decrypted.andThen((bytes) =>
    Result.try({
      try: () => strictUtf8.decode(bytes),
      catch: () => formatError("decrypted plaintext is not valid UTF-8"),
    }),
  );
};

export const SecretBox = {
  fromBase64Key,
  fromEnv,
  seal,
  open,
} as const;

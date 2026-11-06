import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { Result, TaggedError } from "better-result";
import { Base64Url } from "@/lib/vault/base64url";

/**
 * AES-256-GCM sealing for values at rest. Envelope format:
 *
 *   <version>.<base64url iv (12 bytes)>.<base64url ciphertext || tag (16 bytes)>
 *
 * `version` defaults to "v1"; callers that seal different kinds of values
 * under different keys pick their own label (e.g. "d1" for DataBox, "k1" for
 * wrapped DEKs) so an envelope of one kind is rejected as malformed by the
 * other. Optional associated data (e.g. the owning user id) is authenticated
 * but not stored, so an envelope copied to another row fails to open.
 */

const DEFAULT_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

/** The key is not base64 or not 32 bytes. */
export class SecretBoxKeyError extends TaggedError("SecretBoxKeyError")<{
  message: string;
}> {}

/** The envelope is not a well-formed secret-box string of the expected version. */
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
  /** Envelope version label (no dots). Defaults to "v1". */
  readonly version?: string;
};

const formatError = (reason: string) =>
  new SecretBoxFormatError({
    reason,
    message: `Cannot open secret-box envelope: ${reason}. The stored value is unreadable as-is and was not changed; re-create it (e.g. re-pair the phone or re-authorize the client).`,
  });

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const fromKeyBytes = (bytes: Uint8Array): Result<SecretBox, SecretBoxKeyError> => {
  if (bytes.byteLength !== KEY_BYTES) {
    return Result.err(
      new SecretBoxKeyError({
        message: `Secret-box key is ${bytes.byteLength} bytes, expected ${KEY_BYTES}. Generate a key with \`openssl rand -base64 32\`.`,
      }),
    );
  }
  return Result.ok({ key: createSecretKey(bytes) });
};

const fromBase64Key = (keyBase64: string): Result<SecretBox, SecretBoxKeyError> => {
  const trimmed = keyBase64.trim();
  if (!base64Pattern.test(trimmed)) {
    return Result.err(
      new SecretBoxKeyError({
        message: "Secret-box key is not valid base64. Generate a key with `openssl rand -base64 32`.",
      }),
    );
  }
  return fromKeyBytes(Buffer.from(trimmed, "base64"));
};

const sealBytes = (
  box: SecretBox,
  plaintext: Uint8Array,
  options: SecretBoxOptions = {},
): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", box.key, iv, { authTagLength: TAG_BYTES });
  if (options.associatedData !== undefined) {
    cipher.setAAD(utf8.encode(options.associatedData));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  const version = options.version ?? DEFAULT_VERSION;
  return `${version}.${Base64Url.encode(iv)}.${Base64Url.encode(sealed)}`;
};

const openBytes = (
  box: SecretBox,
  envelope: string,
  options: SecretBoxOptions = {},
): Result<Uint8Array, SecretBoxOpenError> => {
  const expectedVersion = options.version ?? DEFAULT_VERSION;
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    return Result.err(formatError(`expected 3 dot-separated parts, got ${parts.length}`));
  }
  const [version, ivPart, sealedPart] = parts;
  if (version !== expectedVersion) {
    return Result.err(
      formatError(`unsupported version "${version}" (expected "${expectedVersion}")`),
    );
  }
  const iv = Base64Url.decode(ivPart);
  if (!iv || iv.byteLength !== IV_BYTES) {
    return Result.err(formatError(`IV must be ${IV_BYTES} bytes of base64url`));
  }
  const sealed = Base64Url.decode(sealedPart);
  if (!sealed || sealed.byteLength < TAG_BYTES) {
    return Result.err(
      formatError(`ciphertext must be base64url of at least ${TAG_BYTES} bytes (the tag)`),
    );
  }
  const ciphertext = sealed.subarray(0, sealed.byteLength - TAG_BYTES);
  const tag = sealed.subarray(sealed.byteLength - TAG_BYTES);

  return Result.try({
    try: () => {
      const decipher = createDecipheriv("aes-256-gcm", box.key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      if (options.associatedData !== undefined) {
        decipher.setAAD(utf8.encode(options.associatedData));
      }
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
    catch: () =>
      new SecretBoxAuthError({
        message:
          "Cannot open secret-box envelope: authentication failed (wrong key, wrong associated data, or the value was modified). The stored value was not changed.",
      }),
  });
};

const seal = (box: SecretBox, plaintext: string, options: SecretBoxOptions = {}): string =>
  sealBytes(box, utf8.encode(plaintext), options);

const open = (
  box: SecretBox,
  envelope: string,
  options: SecretBoxOptions = {},
): Result<string, SecretBoxOpenError> =>
  openBytes(box, envelope, options).andThen((bytes) =>
    Result.try({
      try: () => strictUtf8.decode(bytes),
      catch: () => formatError("decrypted plaintext is not valid UTF-8"),
    }),
  );

export const SecretBox = {
  fromBase64Key,
  fromKeyBytes,
  seal,
  open,
  sealBytes,
  openBytes,
} as const;

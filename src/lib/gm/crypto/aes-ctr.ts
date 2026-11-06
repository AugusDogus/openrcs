import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Result, TaggedError } from "better-result";

// Request/response payload crypto, ported from libgm crypto/aesctr.go.
// Wire layout: AES-256-CTR(ciphertext) || iv (16) || HMAC-SHA256(hmacKey, ciphertext || iv) (32).

const KEY_BYTES = 32;
const IV_BYTES = 16;
const MAC_BYTES = 32;
const MIN_PAYLOAD_BYTES = IV_BYTES + MAC_BYTES;

export class AesCtrKeyLengthError extends TaggedError("AesCtrKeyLengthError")<{
  key: "aesKey" | "hmacKey";
  length: number;
  message: string;
}> {}

export class AesCtrPayloadTooShortError extends TaggedError("AesCtrPayloadTooShortError")<{
  length: number;
  message: string;
}> {}

export class AesCtrHmacMismatchError extends TaggedError("AesCtrHmacMismatchError")<{
  message: string;
}> {}

export type AesCtrDecryptError = AesCtrPayloadTooShortError | AesCtrHmacMismatchError;

/** 32-byte AES-256 key and 32-byte HMAC-SHA256 key (libgm `AESCTRHelper`). */
export type AesCtrHelper = {
  readonly aesKey: Uint8Array;
  readonly hmacKey: Uint8Array;
};

const mac = (hmacKey: Uint8Array, data: Uint8Array): Buffer =>
  createHmac("sha256", hmacKey).update(data).digest();

const ctr = (aesKey: Uint8Array, iv: Uint8Array, data: Uint8Array): Buffer => {
  const cipher = createCipheriv("aes-256-ctr", aesKey, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

export const AesCtrHelper = {
  /** Fresh random keys (libgm `NewAESCTRHelper`). */
  generate(): AesCtrHelper {
    return { aesKey: new Uint8Array(randomBytes(KEY_BYTES)), hmacKey: new Uint8Array(randomBytes(KEY_BYTES)) };
  },

  /** Validates key lengths, for keys loaded from storage. */
  fromKeys(aesKey: Uint8Array, hmacKey: Uint8Array): Result<AesCtrHelper, AesCtrKeyLengthError> {
    for (const [key, value] of [
      ["aesKey", aesKey],
      ["hmacKey", hmacKey],
    ] as const) {
      if (value.length !== KEY_BYTES) {
        return Result.err(
          new AesCtrKeyLengthError({
            key,
            length: value.length,
            message: `request crypto ${key} is ${value.length} bytes, expected ${KEY_BYTES}; the stored session keys are corrupt and the device must be re-paired`,
          }),
        );
      }
    }
    return Result.ok({ aesKey, hmacKey });
  },

  /**
   * Encrypts `plaintext` as ciphertext || iv || HMAC. `iv` defaults to 16
   * random bytes; pass one only to reproduce a known payload.
   */
  encrypt(helper: AesCtrHelper, plaintext: Uint8Array, iv: Uint8Array = randomBytes(IV_BYTES)): Uint8Array {
    const body = Buffer.concat([ctr(helper.aesKey, iv, plaintext), iv]);
    return new Uint8Array(Buffer.concat([body, mac(helper.hmacKey, body)]));
  },

  /** Verifies the HMAC (constant time) and decrypts. */
  decrypt(helper: AesCtrHelper, data: Uint8Array): Result<Uint8Array, AesCtrDecryptError> {
    if (data.length < MIN_PAYLOAD_BYTES) {
      return Result.err(
        new AesCtrPayloadTooShortError({
          length: data.length,
          message: `encrypted payload is ${data.length} bytes, shorter than the ${MIN_PAYLOAD_BYTES}-byte IV + HMAC trailer; it was truncated or is not encrypted`,
        }),
      );
    }
    const body = data.subarray(0, data.length - MAC_BYTES);
    const expected = mac(helper.hmacKey, body);
    if (!timingSafeEqual(data.subarray(data.length - MAC_BYTES), expected)) {
      return Result.err(
        new AesCtrHmacMismatchError({
          message:
            "encrypted payload HMAC does not match; it was corrupted or encrypted with different session keys (re-pair if this persists)",
        }),
      );
    }
    const iv = body.subarray(body.length - IV_BYTES);
    return Result.ok(new Uint8Array(ctr(helper.aesKey, iv, body.subarray(0, body.length - IV_BYTES))));
  },
} as const;

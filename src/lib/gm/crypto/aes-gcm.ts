import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Result, TaggedError } from "better-result";

// Media (attachment) crypto, ported from libgm crypto/aesgcm.go.
// Wire layout: 0x00 || log2(chunkSize) || chunks. Each chunk is
// nonce (12) || AES-256-GCM ciphertext || tag (16) and is chunkSize bytes long
// except the last. AAD per chunk: isLast (1 byte) || chunk index (uint32 BE).

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 2;
const CHUNK_OVERHEAD = NONCE_BYTES + TAG_BYTES;
/** libgm outgoingRawChunkSize. */
const OUTGOING_CHUNK_LOG2 = 15;
/** libgm maxRawChunkSize (1 << 22). */
const MAX_CHUNK_LOG2 = 22;

export class AesGcmKeyLengthError extends TaggedError("AesGcmKeyLengthError")<{
  length: number;
  message: string;
}> {}

/** The data is not libgm's chunked layout, or a chunk failed authentication. */
export class AesGcmDecryptError extends TaggedError("AesGcmDecryptError")<{
  reason: "header" | "chunkSize" | "truncated" | "authentication";
  /** Zero-based chunk index, when a chunk failed. */
  chunk: number | null;
  message: string;
}> {}

const aad = (index: number, isLast: boolean): Uint8Array => {
  const out = new Uint8Array(5);
  out[0] = isLast ? 1 : 0;
  new DataView(out.buffer).setUint32(1, index, false);
  return out;
};

const decryptError = (reason: AesGcmDecryptError["reason"], chunk: number | null, detail: string) =>
  new AesGcmDecryptError({
    reason,
    chunk,
    message: `The attachment could not be decrypted (${detail}). Nothing was returned; the attachment key may be wrong or the download was cut short.`,
  });

const openChunk = (key: Uint8Array, chunk: Uint8Array, index: number, isLast: boolean): Result<Uint8Array, AesGcmDecryptError> => {
  if (chunk.length < CHUNK_OVERHEAD) {
    return Result.err(decryptError("truncated", index, `chunk ${index + 1} is ${chunk.length} bytes, shorter than a nonce and tag`));
  }
  return Result.try({
    try: () => {
      const decipher = createDecipheriv("aes-256-gcm", key, chunk.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAuthTag(chunk.subarray(chunk.length - TAG_BYTES));
      decipher.setAAD(aad(index, isLast));
      return new Uint8Array(
        Buffer.concat([decipher.update(chunk.subarray(NONCE_BYTES, chunk.length - TAG_BYTES)), decipher.final()]),
      );
    },
    catch: () => decryptError("authentication", index, `chunk ${index + 1} failed authentication`),
  });
};

/**
 * Incremental decryptor: feed encrypted bytes in any split with `push`, then
 * call `finish` once. A chunk is only opened once more data follows it,
 * because the final chunk is authenticated as final.
 */
export type AesGcmDecryptor = {
  push(bytes: Uint8Array): Result<Uint8Array[], AesGcmDecryptError>;
  finish(): Result<Uint8Array[], AesGcmDecryptError>;
};

const decryptor = (key: Uint8Array): Result<AesGcmDecryptor, AesGcmKeyLengthError> => {
  if (key.length !== KEY_BYTES) {
    return Result.err(
      new AesGcmKeyLengthError({
        length: key.length,
        message: `The attachment key is ${key.length} bytes, expected ${KEY_BYTES}, so the attachment cannot be decrypted. Nothing was returned.`,
      }),
    );
  }
  let buffer: Uint8Array = new Uint8Array(0);
  let chunkSize: number | null = null;
  let index = 0;

  const drain = (final: boolean): Result<Uint8Array[], AesGcmDecryptError> => {
    const out: Uint8Array[] = [];
    if (chunkSize === null) {
      if (buffer.length < HEADER_BYTES) {
        return final && buffer.length > 0
          ? Result.err(decryptError("truncated", null, "the data ends inside the 2-byte header"))
          : Result.ok(out);
      }
      if (buffer[0] !== 0) return Result.err(decryptError("header", null, "the first byte is not 0"));
      const log2 = buffer[1] ?? 0;
      if (log2 > MAX_CHUNK_LOG2 || 1 << log2 <= CHUNK_OVERHEAD) {
        return Result.err(decryptError("chunkSize", null, `unsupported chunk size 2^${log2}`));
      }
      chunkSize = 1 << log2;
      buffer = buffer.subarray(HEADER_BYTES);
    }
    while (buffer.length > chunkSize) {
      const opened = openChunk(key, buffer.subarray(0, chunkSize), index, false);
      if (opened.isErr()) return Result.err(opened.error);
      out.push(opened.value);
      buffer = buffer.subarray(chunkSize);
      index += 1;
    }
    if (final && buffer.length > 0) {
      const opened = openChunk(key, buffer, index, true);
      if (opened.isErr()) return Result.err(opened.error);
      out.push(opened.value);
      buffer = new Uint8Array(0);
      index += 1;
    }
    return Result.ok(out);
  };

  return Result.ok({
    push(bytes) {
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      return drain(false);
    },
    finish: () => drain(true),
  });
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const AesGcmHelper = {
  decryptor,

  /** libgm `DecryptData` for a whole buffer. */
  decrypt(key: Uint8Array, encrypted: Uint8Array): Result<Uint8Array, AesGcmKeyLengthError | AesGcmDecryptError> {
    return decryptor(key).andThen((d) =>
      d.push(encrypted).andThen((head) => d.finish().map((tail) => concat([...head, ...tail]))),
    );
  },

  /** libgm `EncryptData` (32 KiB chunks, random nonces). */
  encrypt(key: Uint8Array, data: Uint8Array): Result<Uint8Array, AesGcmKeyLengthError> {
    if (key.length !== KEY_BYTES) {
      return Result.err(
        new AesGcmKeyLengthError({
          length: key.length,
          message: `The attachment key is ${key.length} bytes, expected ${KEY_BYTES}, so the attachment cannot be encrypted.`,
        }),
      );
    }
    const plainChunk = (1 << OUTGOING_CHUNK_LOG2) - CHUNK_OVERHEAD;
    const parts: Uint8Array[] = [new Uint8Array([0, OUTGOING_CHUNK_LOG2])];
    for (let offset = 0, index = 0; offset < data.length; offset += plainChunk, index += 1) {
      const isLast = offset + plainChunk >= data.length;
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(index, isLast));
      const body = Buffer.concat([cipher.update(data.subarray(offset, offset + plainChunk)), cipher.final()]);
      parts.push(nonce, body, cipher.getAuthTag());
    }
    return Result.ok(concat(parts));
  },
} as const;

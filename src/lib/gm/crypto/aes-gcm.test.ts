import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/crypto-aes-gcm.json";
import { AesGcmHelper } from "./aes-gcm";

const key = new Uint8Array(Buffer.from(fixture.key, "hex"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const cases = fixture.cases.map((c) => [c.size, c] as const);
const failure = <E>(result: { isErr(): boolean; error?: E }): E => {
  if (!result.isErr() || result.error === undefined) throw new Error("expected an error result");
  return result.error;
};
const encrypted = (c: (typeof fixture.cases)[number]): Uint8Array => new Uint8Array(Buffer.from(c.ciphertext, "base64"));

describe("AesGcmHelper (libgm crypto/aesgcm.go parity)", () => {
  test.each(cases)("decrypts Go ciphertext of a %d-byte plaintext", (size, c) => {
    const plain = AesGcmHelper.decrypt(key, encrypted(c)).unwrap();
    expect(plain.length).toBe(size);
    expect(sha256(plain)).toBe(c.plaintextSha256);
  });

  test.each(cases)("decrypts Go ciphertext of %d bytes fed in uneven pieces", (_, c) => {
    const data = encrypted(c);
    const decryptor = AesGcmHelper.decryptor(key).unwrap();
    const parts: Uint8Array[] = [];
    for (let offset = 0, step = 1; offset < data.length; offset += step, step = (step * 7) % 5000 + 1) {
      parts.push(...decryptor.push(data.subarray(offset, offset + step)).unwrap());
    }
    parts.push(...decryptor.finish().unwrap());
    expect(sha256(Buffer.concat(parts))).toBe(c.plaintextSha256);
  });

  test("encrypt round-trips across chunk boundaries and for empty data", () => {
    for (const size of [0, 1, 32740, 32741, 70000]) {
      const plain = new Uint8Array(size).map((_, i) => i % 251);
      const sealed = AesGcmHelper.encrypt(key, plain).unwrap();
      expect(sha256(AesGcmHelper.decrypt(key, sealed).unwrap())).toBe(sha256(plain));
    }
  });

  test("rejects a modified chunk, a dropped final chunk and a bad header", () => {
    const [, twoChunks] = cases.at(-1) ?? cases[0];
    const data = encrypted(twoChunks);
    const flipped = data.slice();
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    expect(failure(AesGcmHelper.decrypt(key, flipped))).toMatchObject({ reason: "authentication", chunk: 0 });
    // Without its last chunk, the first chunk is not authenticated as final.
    const truncated = data.subarray(0, 2 + 32768);
    expect(failure(AesGcmHelper.decrypt(key, truncated))).toMatchObject({ reason: "authentication" });
    const badHeader = data.slice();
    badHeader[0] = 1;
    expect(failure(AesGcmHelper.decrypt(key, badHeader))).toMatchObject({ reason: "header" });
  });

  test("rejects a key that is not 32 bytes", () => {
    expect(failure(AesGcmHelper.decryptor(new Uint8Array(16)))._tag).toBe("AesGcmKeyLengthError");
  });
});

import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/crypto-aes-ctr.json";
import { type AesCtrDecryptError, AesCtrHelper } from "./aes-ctr";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const helper = AesCtrHelper.fromKeys(fromHex(fixture.aesKey), fromHex(fixture.hmacKey)).unwrap();

describe("AesCtrHelper (libgm crypto/aesctr.go parity)", () => {
  test.each(fixture.cases.map((c) => [c.plaintext.length / 2, c] as const))(
    "decrypts Go ciphertext of a %d-byte plaintext",
    (_, c) => {
      const result = AesCtrHelper.decrypt(helper, fromHex(c.ciphertext));
      expect(result.isOk()).toBe(true);
      expect(toHex(result.unwrap())).toBe(c.plaintext);
    },
  );

  test.each(fixture.cases.map((c) => [c.plaintext.length / 2, c] as const))(
    "reproduces Go ciphertext byte-for-byte with Go's IV (%d-byte plaintext)",
    (_, c) => {
      const goCiphertext = fromHex(c.ciphertext);
      const iv = goCiphertext.subarray(goCiphertext.length - 48, goCiphertext.length - 32);
      expect(toHex(AesCtrHelper.encrypt(helper, fromHex(c.plaintext), iv))).toBe(c.ciphertext);
    },
  );

  test("random-IV encryption has ciphertext || iv || hmac layout and round-trips", () => {
    const plaintext = new TextEncoder().encode("hello from openrcs");
    const a = AesCtrHelper.encrypt(helper, plaintext);
    const b = AesCtrHelper.encrypt(helper, plaintext);
    expect(a.length).toBe(plaintext.length + 48);
    expect(toHex(a)).not.toBe(toHex(b));
    const body = a.subarray(0, a.length - 32);
    const mac = createHmac("sha256", helper.hmacKey).update(body).digest();
    expect(toHex(a.subarray(a.length - 32))).toBe(mac.toString("hex"));
    expect(toHex(AesCtrHelper.decrypt(helper, a).unwrap())).toBe(toHex(plaintext));
  });

  const expectedTag: Record<string, AesCtrDecryptError["_tag"]> = {
    "input data is too short": "AesCtrPayloadTooShortError",
    "HMAC mismatch": "AesCtrHmacMismatchError",
  };
  test.each(fixture.rejected.map((r) => [r.name, r] as const))("rejects like Go: %s", (_, r) => {
    const result = AesCtrHelper.decrypt(helper, fromHex(r.input));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe(expectedTag[r.goError] ?? `unmapped Go error: ${r.goError}`);
  });

  test("fromKeys rejects keys that are not 32 bytes", () => {
    const short = AesCtrHelper.fromKeys(new Uint8Array(16), new Uint8Array(32));
    expect(short.isErr() && short.error.key).toBe("aesKey");
    const long = AesCtrHelper.fromKeys(new Uint8Array(32), new Uint8Array(33));
    expect(long.isErr() && long.error.key).toBe("hmacKey");
  });

  test("generate makes distinct 32-byte keys", () => {
    const a = AesCtrHelper.generate();
    const b = AesCtrHelper.generate();
    expect(a.aesKey.length).toBe(32);
    expect(a.hmacKey.length).toBe(32);
    expect(toHex(a.aesKey)).not.toBe(toHex(b.aesKey));
  });
});

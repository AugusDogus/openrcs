import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SecretBox, SecretBoxAuthError, SecretBoxFormatError } from "@/lib/secret-box";

const keyFromBytes = (bytes: Uint8Array): SecretBox =>
  SecretBox.fromBase64Key(Buffer.from(bytes).toString("base64")).unwrap();

const randomBox = () => keyFromBytes(randomBytes(32));

const hexToBase64Url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Sets a padding bit in the final character (only valid when the length is not a multiple of 4). */
const setUnusedLowBit = (encoded: string): string => {
  const last = BASE64URL_ALPHABET.indexOf(encoded.slice(-1));
  return encoded.slice(0, -1) + BASE64URL_ALPHABET.charAt(last | 1);
};

describe("SecretBox.fromBase64Key", () => {
  test("accepts a 32-byte base64 key (openssl rand -base64 32 format)", () => {
    const key = randomBytes(32).toString("base64");
    expect(key).toHaveLength(44);
    expect(SecretBox.fromBase64Key(key).isOk()).toBe(true);
  });

  test("rejects keys that are not 32 bytes", () => {
    for (const length of [0, 16, 31, 33, 64]) {
      const result = SecretBox.fromBase64Key(randomBytes(length).toString("base64"));
      expect(result.isErr()).toBe(true);
    }
  });

  test("rejects non-base64 input", () => {
    const result = SecretBox.fromBase64Key("not base64 at all!");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("SecretBoxKeyError");
  });
});

describe("SecretBox.seal / open", () => {
  test("round-trips ASCII, unicode and empty strings", () => {
    const box = randomBox();
    for (const plaintext of ["", "hello", '{"cookies":{"SID":"x"}}', "emoji 😀 and ünïcode"]) {
      const envelope = SecretBox.seal(box, plaintext);
      expect(SecretBox.open(box, envelope).unwrap()).toBe(plaintext);
    }
  });

  test("produces the v1 envelope shape with a fresh 12-byte IV each time", () => {
    const box = randomBox();
    const a = SecretBox.seal(box, "same plaintext");
    const b = SecretBox.seal(box, "same plaintext");
    expect(a).not.toBe(b);
    for (const envelope of [a, b]) {
      const [version, iv, sealed] = envelope.split(".");
      expect(version).toBe("v1");
      expect(Buffer.from(iv, "base64url")).toHaveLength(12);
      // "same plaintext" is 14 bytes; GCM ciphertext has the same length, plus a 16-byte tag.
      expect(Buffer.from(sealed, "base64url")).toHaveLength(14 + 16);
    }
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  test("binds associated data: wrong or missing AAD fails authentication", () => {
    const box = randomBox();
    const envelope = SecretBox.seal(box, "secret", { associatedData: "user_a" });
    expect(SecretBox.open(box, envelope, { associatedData: "user_a" }).unwrap()).toBe("secret");

    for (const options of [{ associatedData: "user_b" }, {}]) {
      const result = SecretBox.open(box, envelope, options);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(SecretBoxAuthError.is(result.error)).toBe(true);
    }
  });

  test("a different key fails authentication", () => {
    const envelope = SecretBox.seal(randomBox(), "secret");
    const result = SecretBox.open(randomBox(), envelope);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("SecretBoxAuthError");
  });

  test("tampering with IV, ciphertext or tag fails authentication", () => {
    const box = randomBox();
    const envelope = SecretBox.seal(box, "a reasonably long secret value");
    const [version, ivPart, sealedPart] = envelope.split(".");
    const iv = Buffer.from(ivPart, "base64url");
    const sealed = Buffer.from(sealedPart, "base64url");

    const flip = (bytes: Buffer, index: number) => {
      const copy = Buffer.from(bytes);
      copy[index] ^= 0x01;
      return copy.toString("base64url");
    };

    const tampered = [
      `${version}.${flip(iv, 0)}.${sealedPart}`,
      `${version}.${ivPart}.${flip(sealed, 0)}`,
      `${version}.${ivPart}.${flip(sealed, sealed.length - 1)}`,
    ];
    for (const candidate of tampered) {
      const result = SecretBox.open(box, candidate);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error._tag).toBe("SecretBoxAuthError");
    }
  });

  test("malformed envelopes are format errors, not auth errors", () => {
    const box = randomBox();
    const valid = SecretBox.seal(box, "x");
    const [, ivPart, sealedPart] = valid.split(".");
    const malformed = [
      "",
      "v1",
      "v1.abc",
      `v2.${ivPart}.${sealedPart}`,
      `v1.${ivPart}.${sealedPart}.extra`,
      `v1.${Buffer.alloc(11).toString("base64url")}.${sealedPart}`,
      `v1.${ivPart}.${Buffer.alloc(15).toString("base64url")}`,
      `v1.${ivPart}.not+base64url/`,
      `v1..${sealedPart}`,
      // Non-canonical base64url that Node's lenient decoder maps to the same bytes.
      `v1.${ivPart}A.${sealedPart}`,
      `v1.${ivPart}.${setUnusedLowBit(sealedPart)}`,
    ];
    for (const envelope of malformed.slice(-2)) {
      expect(Buffer.from(envelope.split(".")[1], "base64url")).toEqual(Buffer.from(ivPart, "base64url"));
      expect(Buffer.from(envelope.split(".")[2], "base64url")).toEqual(
        Buffer.from(sealedPart, "base64url"),
      );
    }
    for (const envelope of malformed) {
      const result = SecretBox.open(box, envelope);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(SecretBoxFormatError.is(result.error)).toBe(true);
    }
  });
});

describe("SecretBox interoperability with standard AES-256-GCM", () => {
  // NIST GCM spec (McGrew & Viega) test cases 13 and 14: 256-bit zero key, 96-bit zero IV,
  // no AAD. The envelope layout is iv || (ciphertext || tag), so a standard GCM
  // implementation's output must open unchanged.
  const zeroKeyBox = keyFromBytes(new Uint8Array(32));
  const zeroIv = hexToBase64Url("00".repeat(12));

  test("test case 13: empty plaintext", () => {
    const envelope = `v1.${zeroIv}.${hexToBase64Url("530f8afbc74536b9a963b4f1c4cb738b")}`;
    expect(SecretBox.open(zeroKeyBox, envelope).unwrap()).toBe("");
  });

  test("test case 14: 16 zero bytes", () => {
    const envelope = `v1.${zeroIv}.${hexToBase64Url(
      "cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919",
    )}`;
    expect(SecretBox.open(zeroKeyBox, envelope).unwrap()).toBe("\0".repeat(16));
  });
});

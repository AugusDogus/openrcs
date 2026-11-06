import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DataBox, type DataBoxAad } from "./data-box";
import { Dek } from "./dek";

const aad: DataBoxAad = { userId: "user_1", table: "message", rowKey: "msg_1", column: "content" };

const flipBase64UrlChar = (part: string, index: number): string => {
  const bytes = Buffer.from(part, "base64url");
  bytes[index] ^= 0x01;
  return bytes.toString("base64url");
};

describe("DataBox", () => {
  test("round-trips text with the d1 envelope", () => {
    const dek = Dek.generate();
    const envelope = DataBox.seal(dek, "hello 😀", aad);
    expect(envelope.split(".")[0]).toBe("d1");
    expect(DataBox.open(dek, envelope, aad).unwrap()).toBe("hello 😀");
  });

  test("tampering with IV, ciphertext or tag fails authentication", () => {
    const dek = Dek.generate();
    const [version, iv, sealed] = DataBox.seal(dek, "a message body", aad).split(".");
    const sealedLength = Buffer.from(sealed, "base64url").length;
    for (const tampered of [
      `${version}.${flipBase64UrlChar(iv, 0)}.${sealed}`,
      `${version}.${iv}.${flipBase64UrlChar(sealed, 0)}`,
      `${version}.${iv}.${flipBase64UrlChar(sealed, sealedLength - 1)}`,
    ]) {
      const result = DataBox.open(dek, tampered, aad);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.reason).toBe("authentication");
    }
  });

  test("any AAD field differing fails authentication", () => {
    const dek = Dek.generate();
    const envelope = DataBox.seal(dek, "secret", aad);
    for (const other of [
      { ...aad, userId: "user_2" },
      { ...aad, table: "conversation" },
      { ...aad, rowKey: "msg_2" },
      { ...aad, column: "auth_data" },
      // Field boundaries are unambiguous: shifting a character between fields changes the AAD.
      { ...aad, userId: "user_1m", table: "essage" },
    ]) {
      const result = DataBox.open(dek, envelope, other);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error._tag).toBe("DataBoxOpenError");
        expect(result.error.reason).toBe("authentication");
      }
    }
  });

  test("a different DEK fails authentication", () => {
    const envelope = DataBox.seal(Dek.generate(), "secret", aad);
    const result = DataBox.open(Dek.generate(), envelope, aad);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.reason).toBe("authentication");
  });

  test("other envelope versions and non-canonical base64url are malformed", () => {
    const dek = Dek.generate();
    const [, iv, sealed] = DataBox.seal(dek, "x", aad).split(".");
    for (const envelope of [`v1.${iv}.${sealed}`, `d1.${iv}A.${sealed}`, "d1..", "garbage"]) {
      const result = DataBox.open(dek, envelope, aad);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.reason).toBe("malformed");
    }
  });

  test("error messages never include the plaintext", () => {
    const dek = Dek.generate();
    const envelope = DataBox.seal(dek, "very private words", aad);
    const result = DataBox.open(Dek.generate(), envelope, aad);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).not.toContain("private");
  });

  test("sealJson / openJson validate the decrypted shape", () => {
    const dek = Dek.generate();
    const schema = z.object({ body: z.string(), senderName: z.string().nullable() });
    const envelope = DataBox.sealJson(dek, { body: "hi", senderName: null }, aad);
    expect(DataBox.openJson(dek, envelope, aad, schema).unwrap()).toEqual({
      body: "hi",
      senderName: null,
    });

    const wrongShape = DataBox.sealJson(dek, { body: 42, senderName: "Alice" }, aad);
    const result = DataBox.openJson(dek, wrongShape, aad, schema);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("DataBoxSchemaError");
      expect(result.error.message).toContain("body");
      expect(result.error.message).not.toContain("Alice");
    }
  });
});

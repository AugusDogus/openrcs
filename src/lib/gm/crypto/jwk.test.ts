import { createPublicKey, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/crypto-jwk.json";
import { Jwk, type JwkJson } from "./jwk";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const verifyWithSpki = (spki: Uint8Array, message: string, signature: Uint8Array): boolean =>
  verify(
    "sha256",
    Buffer.from(message, "utf8"),
    { key: createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }), dsaEncoding: "der" },
    signature,
  );

describe("Jwk (libgm crypto/ecdsa.go parity)", () => {
  describe.each(fixture.cases.map((c) => [c.name, c] as const))("key: %s", (_, c) => {
    const parsed = Jwk.fromJson(JSON.parse(c.jwkJson));

    test("imports Go JWK JSON and left-pads values to 32 bytes", () => {
      expect(parsed.isOk()).toBe(true);
      const jwk = parsed.unwrap();
      expect(toHex(jwk.d)).toBe(c.d);
      expect(toHex(jwk.x)).toBe(c.x);
      expect(toHex(jwk.y)).toBe(c.y);
      const xy = Jwk.publicKeyXY(jwk);
      expect(toHex(xy.x)).toBe(c.x);
      expect(toHex(xy.y)).toBe(c.y);
    });

    test("SPKI DER equals Go x509.MarshalPKIXPublicKey", () => {
      expect(toHex(Jwk.publicKeySpkiDer(parsed.unwrap()))).toBe(c.spki);
    });

    test("Go signatures verify against the TS public key", () => {
      const spki = Jwk.publicKeySpkiDer(parsed.unwrap());
      for (const s of c.signatures) {
        expect(verifyWithSpki(spki, `${s.requestId}:${s.timestampMicros}`, fromHex(s.signature))).toBe(true);
        expect(verifyWithSpki(spki, `${s.requestId}:${s.timestampMicros}0`, fromHex(s.signature))).toBe(false);
      }
    });

    test("TS signatures verify against Go's SPKI over `${requestId}:${timestamp}`", () => {
      for (const s of c.signatures) {
        const signature = Jwk.signRequest(parsed.unwrap(), s.requestId, BigInt(s.timestampMicros));
        expect(signature[0]).toBe(0x30); // ASN.1 SEQUENCE
        expect(verifyWithSpki(fromHex(c.spki), `${s.requestId}:${s.timestampMicros}`, signature)).toBe(true);
      }
    });

    test("toJson emits 32-byte unpadded base64url values that parse back", () => {
      const json = Jwk.toJson(parsed.unwrap());
      expect(Object.keys(json)).toEqual(["kty", "crv", "d", "x", "y"]);
      for (const value of [json.d, json.x, json.y]) {
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(value, "base64url").length).toBe(32);
      }
      expect(toHex(Jwk.fromJson(json).unwrap().d)).toBe(c.d);
    });
  });

  test("generate produces a key that survives a JSON round trip", () => {
    const jwk = Jwk.generate();
    const back = Jwk.fromJson(JSON.parse(JSON.stringify(Jwk.toJson(jwk)))).unwrap();
    expect(toHex(back.d)).toBe(toHex(jwk.d));
    const signature = Jwk.signRequest(jwk, "id", 5n);
    expect(verifyWithSpki(Jwk.publicKeySpkiDer(back), "id:5", signature)).toBe(true);
  });

  describe("fromJson rejects malformed keys", () => {
    const base: unknown = JSON.parse(fixture.cases[0]?.jwkJson ?? "null");
    const valid: JwkJson = Jwk.toJson(Jwk.fromJson(base).unwrap());
    const other: JwkJson = Jwk.toJson(Jwk.generate());
    test.each([
      ["not an object", "x", "jwk"],
      ["wrong kty", { ...valid, kty: "RSA" }, "kty"],
      ["wrong crv", { ...valid, crv: "P-384" }, "crv"],
      ["missing d", { kty: "EC", crv: "P-256", x: valid.x, y: valid.y }, "d"],
      ["padded base64", { ...valid, x: `${valid.x}=` }, "x"],
      ["standard base64 alphabet", { ...valid, y: "+/" + valid.y.slice(2) }, "y"],
      ["value wider than 32 bytes", { ...valid, d: Buffer.alloc(33, 1).toString("base64url") }, "d"],
      ["zero scalar", { ...valid, d: "AA" }, "d"],
      ["public key of a different d", { ...valid, x: other.x, y: other.y }, "jwk"],
    ] as const)("%s", (_, input, field) => {
      const result = Jwk.fromJson(input);
      expect(result.isErr() && result.error.field).toBe(field);
    });
  });
});

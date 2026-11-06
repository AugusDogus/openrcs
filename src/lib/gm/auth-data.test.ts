import { describe, expect, test } from "bun:test";
import { create, equals, toBinary } from "@bufbuild/protobuf";

import { DeviceSchema } from "@/gen/gmproto/authentication_pb";

import { AuthData, NIL_UUID } from "./auth-data";
import { Jwk } from "./crypto/jwk";

const sample = (): AuthData => {
  const a = AuthData.createForPairing();
  a.browser = create(DeviceSchema, { userID: 123456789012345n, sourceID: "browser-src", network: "Bugle" });
  a.mobile = create(DeviceSchema, { userID: 2n, sourceID: "mobile-src", network: "" });
  a.tachyonAuthToken = Uint8Array.of(0, 1, 2, 250, 255);
  a.tachyonExpiry = new Date("2026-11-07T12:34:56.789Z");
  a.tachyonTtlMicros = 86_400_000_000n;
  a.sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  a.destRegId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  a.pairingId = "16fd2706-8baf-433b-82eb-8c7fada847da";
  a.cookies = { SID: "a", SAPISID: "b/c", "__Secure-1PSID": "d" };
  return a;
};

const sameDevice = (a: AuthData["browser"], b: AuthData["browser"]): boolean =>
  a === null || b === null ? a === b : equals(DeviceSchema, a, b);

describe("AuthData", () => {
  test("serialize/parse round-trips every field", () => {
    const a = sample();
    const b = AuthData.parse(AuthData.serialize(a)).unwrap();
    expect(b.requestCrypto.aesKey).toEqual(a.requestCrypto.aesKey);
    expect(b.requestCrypto.hmacKey).toEqual(a.requestCrypto.hmacKey);
    expect(Jwk.toJson(b.refreshKey)).toEqual(Jwk.toJson(a.refreshKey));
    expect(sameDevice(b.browser, a.browser)).toBe(true);
    expect(sameDevice(b.mobile, a.mobile)).toBe(true);
    expect(b.tachyonAuthToken).toEqual(a.tachyonAuthToken);
    expect(b.tachyonExpiry?.toISOString()).toBe("2026-11-07T12:34:56.789Z");
    expect(b.tachyonTtlMicros).toBe(86_400_000_000n);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.destRegId).toBe(a.destRegId);
    expect(b.pairingId).toBe(a.pairingId);
    expect(b.cookies).toEqual(a.cookies);
    // Serialization is stable.
    expect(AuthData.serialize(b)).toBe(AuthData.serialize(a));
  });

  test("a fresh pairing AuthData round-trips with nulls and the nil session id", () => {
    const a = AuthData.createForPairing();
    const b = AuthData.parse(AuthData.serialize(a)).unwrap();
    expect(b.sessionId).toBe(NIL_UUID);
    expect([b.browser, b.mobile, b.tachyonAuthToken, b.tachyonExpiry, b.destRegId, b.pairingId, b.cookies]).toEqual([null, null, null, null, null, null, null]);
    expect(AuthData.isLoggedIn(b)).toBe(false);
    expect(AuthData.isGoogleAccount(b)).toBe(false);
  });

  test("bytes are padded base64, devices binary protobuf, bigint a decimal string", () => {
    const a = sample();
    const json: unknown = JSON.parse(AuthData.serialize(a));
    if (a.browser === null) throw new Error("sample has a browser");
    expect(json).toMatchObject({
      v: 1,
      tachyonAuthToken: "AAEC+v8=",
      tachyonTtlMicros: "86400000000",
      browser: Buffer.from(toBinary(DeviceSchema, a.browser)).toString("base64"),
    });
  });

  test("isLoggedIn needs a browser, and cookies for Google-account sessions", () => {
    const a = sample();
    expect(AuthData.isLoggedIn(a)).toBe(true);
    a.cookies = null;
    expect(AuthData.isLoggedIn(a)).toBe(false);
    a.destRegId = null;
    expect(AuthData.isLoggedIn(a)).toBe(true);
    a.browser = null;
    expect(AuthData.isLoggedIn(a)).toBe(false);
  });

  test("applyTokenData treats TTL 0 as 24 h", () => {
    const a = AuthData.createForPairing();
    const now = new Date("2026-01-01T00:00:00Z");
    AuthData.applyTokenData(a, Uint8Array.of(1), 0n, now);
    expect(a.tachyonTtlMicros).toBe(86_400_000_000n);
    expect(a.tachyonExpiry?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(AuthData.needsTokenRefresh(a, now)).toBe(false);
    expect(AuthData.needsTokenRefresh(a, new Date("2026-01-01T23:00:00Z"))).toBe(true);
  });

  test("the nil UUID as destRegId means a QR session", () => {
    const json: Record<string, unknown> = JSON.parse(AuthData.serialize(sample()));
    json.destRegId = NIL_UUID;
    expect(AuthData.parse(JSON.stringify(json)).unwrap().destRegId).toBeNull();
  });

  test.each([
    ["not JSON", "{", "(root)"],
    ["wrong version", JSON.stringify({ v: 2 }), "v"],
    ["bad base64", null, "tachyonAuthToken"],
    ["bad device", null, "browser"],
    ["bad uuid", null, "sessionId"],
    ["bad ttl", null, "tachyonTtlMicros"],
    ["bad key length", null, "requestCrypto"],
  ])("parse rejects %s and names the field without values", (_, raw, field) => {
    const base: Record<string, unknown> = JSON.parse(AuthData.serialize(sample()));
    const mutate: Record<string, (j: Record<string, unknown>) => void> = {
      tachyonAuthToken: (j) => (j.tachyonAuthToken = "not base64!"),
      browser: (j) => (j.browser = "/w=="),
      sessionId: (j) => (j.sessionId = "nope"),
      tachyonTtlMicros: (j) => (j.tachyonTtlMicros = "-1"),
      requestCrypto: (j) => (j.requestCrypto = { aesKey: "AAAA", hmacKey: "AAAA" }),
    };
    mutate[field]?.(base);
    const result = AuthData.parse(raw ?? JSON.stringify(base));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field.startsWith(field)).toBe(true);
      expect(result.error.message).toContain("re-paired");
      expect(result.error.message).not.toContain("b/c");
    }
  });
});

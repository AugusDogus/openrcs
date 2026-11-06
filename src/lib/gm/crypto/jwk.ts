import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { P256KeyPair } from "./p256";

// ECDSA P-256 refresh key, ported from libgm crypto/ecdsa.go. Persisted as a
// JWK with unpadded base64url values (Go's RawURLBytes). Go fills them from
// big.Int.Bytes(), so stored values may be shorter than 32 bytes; we accept any
// width on import and always emit 32 bytes (which Go reads back identically).

/** The refresh key: a P-256 key pair with 32-byte big-endian `d`, `x`, `y`. */
export type Jwk = P256KeyPair;

/** JSON form, field order as Go's `crypto.JWK` marshals it. */
export type JwkJson = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly d: string;
  readonly x: string;
  readonly y: string;
};

export class JwkParseError extends TaggedError("JwkParseError")<{
  field: "jwk" | "kty" | "crv" | "d" | "x" | "y";
  message: string;
  cause?: unknown;
}> {}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

/** Strict unpadded base64url, like Go's base64.RawURLEncoding. */
const decodeRawUrl = (value: string): Uint8Array | undefined =>
  BASE64URL.test(value) && value.length % 4 !== 1 ? new Uint8Array(Buffer.from(value, "base64url")) : undefined;

const parseInteger = (
  record: Record<string, unknown>,
  field: "d" | "x" | "y",
): Result<Uint8Array, JwkParseError> => {
  const raw = record[field];
  if (typeof raw !== "string") {
    return Result.err(new JwkParseError({ field, message: `refresh key JWK field "${field}" is missing or not a string` }));
  }
  const decoded = decodeRawUrl(raw);
  if (decoded === undefined) {
    return Result.err(
      new JwkParseError({ field, message: `refresh key JWK field "${field}" is not unpadded base64url` }),
    );
  }
  return P256KeyPair.toFieldBytes(decoded).mapError(
    (cause) =>
      new JwkParseError({ field, message: `refresh key JWK field "${field}" is wider than 32 bytes`, cause }),
  );
};

const nodeJwk = (jwk: Jwk) => ({ kty: "EC", crv: "P-256", x: encode(jwk.x), y: encode(jwk.y) });

const privateKeyObject = (jwk: Jwk): KeyObject =>
  createPrivateKey({ key: { ...nodeJwk(jwk), d: encode(jwk.d) }, format: "jwk" });

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

export const Jwk = {
  /** New random refresh key (libgm `crypto.GenerateECDSAKey`). */
  generate(): Jwk {
    return P256KeyPair.generate();
  },

  /**
   * Parses a stored JWK (`AuthData.refresh_key`). Requires kty "EC" and crv
   * "P-256" (the only values libgm writes) and checks that x/y is d's public key.
   */
  fromJson(value: unknown): Result<Jwk, JwkParseError> {
    return Result.gen(function* () {
      if (!isRecord(value)) {
        return Result.err(new JwkParseError({ field: "jwk", message: "refresh key JWK is not a JSON object" }));
      }
      if (value.kty !== "EC") {
        return Result.err(new JwkParseError({ field: "kty", message: 'refresh key JWK "kty" is not "EC"' }));
      }
      if (value.crv !== "P-256") {
        return Result.err(new JwkParseError({ field: "crv", message: 'refresh key JWK "crv" is not "P-256"' }));
      }
      const d = yield* parseInteger(value, "d");
      const x = yield* parseInteger(value, "x");
      const y = yield* parseInteger(value, "y");
      const derived = yield* P256KeyPair.fromPrivateScalar(d).mapError(
        (cause) => new JwkParseError({ field: "d", message: 'refresh key JWK "d" is not a valid P-256 scalar', cause }),
      );
      if (!equalBytes(derived.x, x) || !equalBytes(derived.y, y)) {
        return Result.err(
          new JwkParseError({
            field: "jwk",
            message: 'refresh key JWK "x"/"y" do not match the public key of "d"; the stored key is corrupt',
          }),
        );
      }
      return Result.ok(derived);
    });
  },

  /** JSON form with 32-byte values. */
  toJson(jwk: Jwk): JwkJson {
    return { kty: "EC", crv: "P-256", d: encode(jwk.d), x: encode(jwk.x), y: encode(jwk.y) };
  },

  /**
   * ASN.1 DER ECDSA signature over SHA-256(`${requestId}:${timestampMicros}`),
   * as libgm's refreshAuthToken does (sha256.Sum256 then ecdsa.SignASN1 on the
   * digest; node hashes the message once here).
   */
  signRequest(jwk: Jwk, requestId: string, timestampMicros: bigint): Uint8Array {
    const message = Buffer.from(`${requestId}:${timestampMicros.toString()}`, "utf8");
    return new Uint8Array(sign("sha256", message, { key: privateKeyObject(jwk), dsaEncoding: "der" }));
  },

  /** SubjectPublicKeyInfo DER, byte-identical to Go's x509.MarshalPKIXPublicKey. */
  publicKeySpkiDer(jwk: Jwk): Uint8Array {
    const key = createPublicKey({ key: nodeJwk(jwk), format: "jwk" });
    return new Uint8Array(key.export({ type: "spki", format: "der" }));
  },

  /** Raw 32-byte big-endian public coordinates. */
  publicKeyXY(jwk: Jwk): { readonly x: Uint8Array; readonly y: Uint8Array } {
    return { x: jwk.x, y: jwk.y };
  },
} as const;

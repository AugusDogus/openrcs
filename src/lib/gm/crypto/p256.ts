import { createECDH } from "node:crypto";
import { Result, TaggedError } from "better-result";

// NIST P-256 key material as raw fixed-width big-endian bytes, shared by the
// refresh key (jwk.ts) and the Gaia pairing key (ukey2.ts).

const CURVE = "prime256v1";
const FIELD_BYTES = 32;

export class P256InvalidPrivateKeyError extends TaggedError("P256InvalidPrivateKeyError")<{
  message: string;
  cause: unknown;
}> {}

export class P256InvalidPublicKeyError extends TaggedError("P256InvalidPublicKeyError")<{
  message: string;
  cause: unknown;
}> {}

export class P256OverlongIntegerError extends TaggedError("P256OverlongIntegerError")<{
  length: number;
  message: string;
}> {}

/** A P-256 key pair. `d`, `x` and `y` are always 32-byte big-endian values. */
export type P256KeyPair = {
  readonly d: Uint8Array;
  readonly x: Uint8Array;
  readonly y: Uint8Array;
};

const bytes = (buf: Uint8Array): Uint8Array => new Uint8Array(buf);

/**
 * Interprets `value` as an unsigned big-endian integer (like Go's
 * `big.Int.SetBytes`) and re-encodes it as exactly 32 bytes. Fails only when
 * the integer needs more than 256 bits.
 */
const toFieldBytes = (value: Uint8Array): Result<Uint8Array, P256OverlongIntegerError> => {
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  const significant = value.length - start;
  if (significant > FIELD_BYTES) {
    return Result.err(
      new P256OverlongIntegerError({
        length: value.length,
        message: `P-256 value has ${significant} significant bytes, more than the 32-byte field size`,
      }),
    );
  }
  const out = new Uint8Array(FIELD_BYTES);
  out.set(value.subarray(start), FIELD_BYTES - significant);
  return Result.ok(out);
};

const uncompressedPoint = (x: Uint8Array, y: Uint8Array): Uint8Array => {
  const out = new Uint8Array(1 + 2 * FIELD_BYTES);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 1 + FIELD_BYTES);
  return out;
};

const fromEcdhPublicKey = (d: Uint8Array, publicKey: Uint8Array): P256KeyPair => ({
  d,
  x: bytes(publicKey.subarray(1, 1 + FIELD_BYTES)),
  y: bytes(publicKey.subarray(1 + FIELD_BYTES, 1 + 2 * FIELD_BYTES)),
});

export const P256KeyPair = {
  fieldBytes: FIELD_BYTES,
  toFieldBytes,

  generate(): P256KeyPair {
    const ecdh = createECDH(CURVE);
    const publicKey = ecdh.generateKeys();
    // getPrivateKey() may drop leading zero bytes; a fresh scalar is always < n.
    const d = toFieldBytes(ecdh.getPrivateKey()).unwrap();
    return fromEcdhPublicKey(d, publicKey);
  },

  /** Builds the key pair for scalar `d` (any width, big-endian), rejecting 0 and values >= n. */
  fromPrivateScalar(d: Uint8Array): Result<P256KeyPair, P256InvalidPrivateKeyError> {
    const scalar = toFieldBytes(d);
    if (scalar.isErr()) {
      return Result.err(
        new P256InvalidPrivateKeyError({ message: "P-256 private scalar is longer than 32 bytes", cause: scalar.error }),
      );
    }
    const fixed = scalar.value;
    return Result.try({
      try: () => {
        const ecdh = createECDH(CURVE);
        ecdh.setPrivateKey(fixed);
        return fromEcdhPublicKey(fixed, ecdh.getPublicKey());
      },
      catch: (cause) =>
        new P256InvalidPrivateKeyError({
          message: "P-256 private scalar is not in [1, n-1]; the key is corrupt or not a P-256 key",
          cause,
        }),
    });
  },

  /**
   * ECDH: the 32-byte X coordinate of d * (peerX, peerY), matching Go's
   * `ecdh.PrivateKey.ECDH`. Peer coordinates must already be 32 bytes.
   */
  sharedSecret(
    key: P256KeyPair,
    peerX: Uint8Array,
    peerY: Uint8Array,
  ): Result<Uint8Array, P256InvalidPrivateKeyError | P256InvalidPublicKeyError> {
    const ecdh = createECDH(CURVE);
    const own = Result.try({
      try: () => ecdh.setPrivateKey(key.d),
      catch: (cause) =>
        new P256InvalidPrivateKeyError({ message: "own P-256 private scalar is not in [1, n-1]", cause }),
    });
    if (own.isErr()) return Result.err(own.error);
    return Result.try({
      try: () => bytes(ecdh.computeSecret(uncompressedPoint(peerX, peerY))),
      catch: (cause) =>
        new P256InvalidPublicKeyError({ message: "peer P-256 public key is not a valid point on the curve", cause }),
    });
  },
} as const;

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { panic, Result, TaggedError } from "better-result";
import type { GaiaPairingResponseContainer } from "@/gen/gmproto/authentication_pb";
import {
  EcP256PublicKeySchema,
  GenericPublicKeySchema,
  PublicKeyType,
  Ukey2ClientFinishedSchema,
  Ukey2ClientInit_CipherCommitmentSchema,
  Ukey2ClientInitSchema,
  Ukey2HandshakeCipher,
  Ukey2Message_Type,
  Ukey2MessageSchema,
  Ukey2ServerInitSchema,
} from "@/gen/gmproto/ukey_pb";
import type { AesCtrHelper } from "./aes-ctr";
import { pairingEmojisV0, pairingEmojisV1 } from "./emoji";
import { P256InvalidPrivateKeyError, P256KeyPair } from "./p256";

// Gaia (Google account) pairing: the client side of the UKEY2 handshake,
// ported from libgm pair_google.go (PairingSession, ProcessServerInit and the
// key-derivation block of FinishGaiaPairing).

const RANDOM_BYTES = 32;
const NEXT_PROTOCOL = "AES_256_CBC-HMAC_SHA256";
const ENCRYPTION_KEY_INFO = Uint8Array.from([
  130, 170, 85, 160, 211, 151, 248, 131, 70, 202, 28, 238, 141, 57, 9, 185, 95, 19, 250, 125, 235, 29, 74, 179, 131,
  118, 184, 37, 109, 168, 85, 16,
]);

export class Ukey2DecodeError extends TaggedError("Ukey2DecodeError")<{
  part: "Ukey2Message" | "Ukey2ServerInit";
  message: string;
  cause: unknown;
}> {}

export class Ukey2UnexpectedMessageTypeError extends TaggedError("Ukey2UnexpectedMessageTypeError")<{
  messageType: number;
  message: string;
}> {}

export class Ukey2UnexpectedVersionError extends TaggedError("Ukey2UnexpectedVersionError")<{
  version: number;
  message: string;
}> {}

export class Ukey2UnexpectedCipherError extends TaggedError("Ukey2UnexpectedCipherError")<{
  cipher: number;
  message: string;
}> {}

export class Ukey2UnexpectedRandomLengthError extends TaggedError("Ukey2UnexpectedRandomLengthError")<{
  length: number;
  message: string;
}> {}

export class Ukey2ServerKeyPrefixError extends TaggedError("Ukey2ServerKeyPrefixError")<{
  coordinate: "x" | "y";
  prefix: number;
  message: string;
}> {}

export class Ukey2InvalidServerKeyError extends TaggedError("Ukey2InvalidServerKeyError")<{
  message: string;
  cause: unknown;
}> {}

export class UnsupportedVerificationCodeVersionError extends TaggedError("UnsupportedVerificationCodeVersionError")<{
  version: number;
  message: string;
}> {}

export class UnsupportedKeyDerivationVersionError extends TaggedError("UnsupportedKeyDerivationVersionError")<{
  version: number;
  message: string;
}> {}

export type ProcessServerInitError =
  | Ukey2DecodeError
  | Ukey2UnexpectedMessageTypeError
  | Ukey2UnexpectedVersionError
  | Ukey2UnexpectedCipherError
  | Ukey2UnexpectedRandomLengthError
  | Ukey2ServerKeyPrefixError
  | Ukey2InvalidServerKeyError
  | P256InvalidPrivateKeyError
  | UnsupportedVerificationCodeVersionError;

/** A started Gaia pairing attempt with its UKEY2 payloads already built. */
export type PairingSession = {
  /** Pairing attempt ID (libgm `PairingSession.UUID`). */
  readonly uuid: string;
  readonly start: Date;
  /** Ephemeral UKEY2 key (libgm `PairingKeyDSA`). */
  readonly pairingKey: P256KeyPair;
  /** Serialized Ukey2Message(CLIENT_INIT), sent with CREATE_GAIA_PAIRING_CLIENT_INIT. */
  readonly initPayload: Uint8Array;
  /** Serialized Ukey2Message(CLIENT_FINISH), sent with CREATE_GAIA_PAIRING_CLIENT_FINISHED. */
  readonly finishPayload: Uint8Array;
};

/** Overrides for deterministic tests; production code passes nothing. */
export type PairingSessionOptions = {
  readonly uuid?: string;
  readonly start?: Date;
  readonly privateKey?: P256KeyPair;
  /** The 32-byte Ukey2ClientInit random. */
  readonly random?: Uint8Array;
};

export type ServerInitResult = {
  /** Emoji the user must pick on the phone. */
  readonly emoji: string;
  /** UKEY2 "next" secret, input to {@link PairingSession.deriveRequestCrypto}. */
  readonly nextKey: Uint8Array;
};

const utf8 = (value: string): Uint8Array => Buffer.from(value, "utf8");

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

/** HKDF-SHA256 with a 32-byte output (one expand block), as libgm `doHKDF`. */
const hkdf = (key: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array => {
  const prk = createHmac("sha256", salt).update(key).digest();
  return new Uint8Array(createHmac("sha256", prk).update(info).update(Uint8Array.of(1)).digest());
};

/** Java-style `Arrays.hashCode(byte[])` with int32 wraparound, as libgm `byteHash`. */
export const byteHash = (data: Uint8Array): number => {
  let out = 1;
  for (const b of data) {
    out = (Math.imul(31, out) + ((b << 24) >> 24)) | 0;
  }
  return out;
};

/**
 * 33-byte UKEY2 coordinate: 0x00 then the 32-byte big-endian value,
 * right-aligned like Go's `big.Int.FillBytes(buf[1:])`.
 */
const ukeyCoordinate = (value: Uint8Array): Uint8Array => {
  const out = new Uint8Array(1 + P256KeyPair.fieldBytes);
  out.set(value, out.length - value.length);
  return out;
};

const decode = <Desc extends DescMessage>(
  schema: Desc,
  data: Uint8Array,
  part: Ukey2DecodeError["part"],
): Result<MessageShape<Desc>, Ukey2DecodeError> => {
  // Result.try cannot infer through MessageShape<Desc> (Awaited<> on a generic).
  try {
    return Result.ok(fromBinary(schema, data));
  } catch (cause) {
    return Result.err(
      new Ukey2DecodeError({
        part,
        message: `Gaia pairing server init is not a valid ${part} protobuf; the response is corrupt or from an unknown protocol revision`,
        cause,
      }),
    );
  }
};

/** libgm accepts a 33-byte coordinate only with a 0x00 prefix; other lengths pass through. */
const stripCoordinatePrefix = (
  value: Uint8Array,
  coordinate: "x" | "y",
): Result<Uint8Array, Ukey2ServerKeyPrefixError> => {
  if (value.length !== 33) return Result.ok(value);
  const prefix = value[0] ?? 0;
  if (prefix !== 0) {
    return Result.err(
      new Ukey2ServerKeyPrefixError({
        coordinate,
        prefix,
        message: `Gaia pairing server key ${coordinate} coordinate has prefix byte ${prefix}, expected 0; the server key is malformed`,
      }),
    );
  }
  return Result.ok(value.subarray(1));
};

/** Big-endian coordinate (prefix already stripped) as 32 bytes. */
const serverCoordinate = (
  value: Uint8Array,
  coordinate: "x" | "y",
): Result<Uint8Array, Ukey2InvalidServerKeyError> =>
  P256KeyPair.toFieldBytes(value).mapError(
    (cause) =>
      new Ukey2InvalidServerKeyError({
        message: `Gaia pairing server key ${coordinate} coordinate overflows 256 bits; the server key is malformed`,
        cause,
      }),
  );

const preparePayloads = (
  publicKey: { readonly x: Uint8Array; readonly y: Uint8Array },
  random: Uint8Array,
): { readonly initPayload: Uint8Array; readonly finishPayload: Uint8Array } => {
  const finished = create(Ukey2ClientFinishedSchema, {
    publicKey: create(GenericPublicKeySchema, {
      type: PublicKeyType.EC_P256,
      publicKey: {
        case: "ecP256PublicKey",
        value: create(EcP256PublicKeySchema, { x: ukeyCoordinate(publicKey.x), y: ukeyCoordinate(publicKey.y) }),
      },
    }),
  });
  const finishPayload = toBinary(
    Ukey2MessageSchema,
    create(Ukey2MessageSchema, {
      messageType: Ukey2Message_Type.CLIENT_FINISH,
      messageData: toBinary(Ukey2ClientFinishedSchema, finished),
    }),
  );
  const commitment = new Uint8Array(createHash("sha512").update(finishPayload).digest());
  const clientInit = create(Ukey2ClientInitSchema, {
    version: 1,
    random,
    cipherCommitments: [
      create(Ukey2ClientInit_CipherCommitmentSchema, {
        handshakeCipher: Ukey2HandshakeCipher.P256_SHA512,
        commitment,
      }),
    ],
    nextProtocol: NEXT_PROTOCOL,
  });
  const initPayload = toBinary(
    Ukey2MessageSchema,
    create(Ukey2MessageSchema, {
      messageType: Ukey2Message_Type.CLIENT_INIT,
      messageData: toBinary(Ukey2ClientInitSchema, clientInit),
    }),
  );
  return { initPayload, finishPayload };
};

export const PairingSession = {
  /** libgm `NewPairingSession` + `PreparePayloads`. */
  create(options: PairingSessionOptions = {}): PairingSession {
    const pairingKey = options.privateKey ?? P256KeyPair.generate();
    const random = options.random ?? new Uint8Array(randomBytes(RANDOM_BYTES));
    if (random.length !== RANDOM_BYTES) {
      panic(`PairingSession.create: random override is ${random.length} bytes, expected ${RANDOM_BYTES}`);
    }
    return {
      uuid: options.uuid ?? randomUUID(),
      start: options.start ?? new Date(),
      pairingKey,
      ...preparePayloads(pairingKey, random),
    };
  },

  /**
   * Builds Ukey2Message(CLIENT_INIT) and Ukey2Message(CLIENT_FINISH) bytes,
   * identical to libgm `PreparePayloads` for the same key and random.
   */
  preparePayloads,

  /**
   * libgm `ProcessServerInit`: validates the server's Ukey2ServerInit, runs
   * ECDH and returns the verification emoji plus the UKEY2 next key.
   */
  processServerInit(
    session: PairingSession,
    container: GaiaPairingResponseContainer,
  ): Result<ServerInitResult, ProcessServerInitError> {
    return Result.gen(function* () {
      const message = yield* decode(Ukey2MessageSchema, container.data, "Ukey2Message");
      if (message.messageType !== Ukey2Message_Type.SERVER_INIT) {
        return Result.err(
          new Ukey2UnexpectedMessageTypeError({
            messageType: message.messageType,
            message: `Gaia pairing expected a UKEY2 SERVER_INIT, got ${Ukey2Message_Type[message.messageType] ?? message.messageType}; the phone may have sent an alert instead`,
          }),
        );
      }
      const serverInit = yield* decode(Ukey2ServerInitSchema, message.messageData, "Ukey2ServerInit");
      if (serverInit.version !== 1) {
        return Result.err(
          new Ukey2UnexpectedVersionError({
            version: serverInit.version,
            message: `Gaia pairing server init uses UKEY2 version ${serverInit.version}, only version 1 is supported`,
          }),
        );
      }
      if (serverInit.handshakeCipher !== Ukey2HandshakeCipher.P256_SHA512) {
        return Result.err(
          new Ukey2UnexpectedCipherError({
            cipher: serverInit.handshakeCipher,
            message: `Gaia pairing server chose handshake cipher ${Ukey2HandshakeCipher[serverInit.handshakeCipher] ?? serverInit.handshakeCipher}, only P256_SHA512 is supported`,
          }),
        );
      }
      if (serverInit.random.length !== RANDOM_BYTES) {
        return Result.err(
          new Ukey2UnexpectedRandomLengthError({
            length: serverInit.random.length,
            message: `Gaia pairing server init random is ${serverInit.random.length} bytes, expected ${RANDOM_BYTES}`,
          }),
        );
      }
      const key = serverInit.publicKey?.publicKey;
      const empty = new Uint8Array(0);
      const ecKey = key?.case === "ecP256PublicKey" ? key.value : undefined;
      // Like libgm: both prefix checks run before either value is validated.
      const rawX = yield* stripCoordinatePrefix(ecKey?.x ?? empty, "x");
      const rawY = yield* stripCoordinatePrefix(ecKey?.y ?? empty, "y");
      const x = yield* serverCoordinate(rawX, "x");
      const y = yield* serverCoordinate(rawY, "y");
      const diffieHellman = yield* P256KeyPair.sharedSecret(session.pairingKey, x, y).mapError((error) =>
        P256InvalidPrivateKeyError.is(error)
          ? error
          : new Ukey2InvalidServerKeyError({
              message: "Gaia pairing server public key is not a valid P-256 point",
              cause: error,
            }),
      );
      const sharedSecret = sha256(diffieHellman);
      const authInfo = Buffer.concat([session.initPayload, container.data]);
      const auth = hkdf(sharedSecret, utf8("UKEY2 v1 auth"), authInfo);
      const nextKey = hkdf(sharedSecret, utf8("UKEY2 v1 next"), authInfo);
      const authNumber = new DataView(auth.buffer, auth.byteOffset, auth.byteLength).getUint32(0, false);
      const version = container.confirmedVerificationCodeVersion;
      const table = version === 0 ? pairingEmojisV0 : version === 1 ? pairingEmojisV1 : undefined;
      if (table === undefined) {
        return Result.err(
          new UnsupportedVerificationCodeVersionError({
            version,
            message: `Gaia pairing server confirmed verification code version ${version}, only 0 and 1 are supported`,
          }),
        );
      }
      const emoji = table[authNumber % table.length];
      if (emoji === undefined) {
        return panic(`pairing emoji index ${authNumber % table.length} out of range for table of ${table.length}`);
      }
      return Result.ok({ emoji, nextKey });
    });
  },

  /**
   * Request crypto keys from the UKEY2 next key: the key-derivation block of
   * libgm `FinishGaiaPairing`, for the server's confirmedKeyDerivationVersion.
   */
  deriveRequestCrypto(
    nextKey: Uint8Array,
    keyDerivationVersion: number,
  ): Result<AesCtrHelper, UnsupportedKeyDerivationVersionError> {
    const clientKey = hkdf(nextKey, ENCRYPTION_KEY_INFO, utf8("client"));
    const serverKey = hkdf(nextKey, ENCRYPTION_KEY_INFO, utf8("server"));
    switch (keyDerivationVersion) {
      case 0:
        return Result.ok({ aesKey: clientKey, hmacKey: serverKey });
      case 1: {
        const [first, second] =
          byteHash(clientKey) < byteHash(serverKey) ? [clientKey, serverKey] : [serverKey, clientKey];
        const concatHash = sha256(Buffer.concat([ENCRYPTION_KEY_INFO, first, second]));
        return Result.ok({
          aesKey: hkdf(concatHash, utf8("Ditto salt 1"), utf8("Ditto info 1")),
          hmacKey: hkdf(concatHash, utf8("Ditto salt 2"), utf8("Ditto info 2")),
        });
      }
      default:
        return Result.err(
          new UnsupportedKeyDerivationVersionError({
            version: keyDerivationVersion,
            message: `Gaia pairing server confirmed key derivation version ${keyDerivationVersion}, only 0 and 1 are supported; pairing cannot finish`,
          }),
        );
    }
  },
} as const;

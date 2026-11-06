import { createHash } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { GaiaPairingResponseContainerSchema } from "@/gen/gmproto/authentication_pb";
import { Ukey2ClientInitSchema, Ukey2HandshakeCipher, Ukey2Message_Type, Ukey2MessageSchema } from "@/gen/gmproto/ukey_pb";
import fixture from "../__fixtures__/crypto-ukey2.json";
import { P256KeyPair } from "./p256";
import { byteHash, PairingSession, type ProcessServerInitError } from "./ukey2";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const sessions = fixture.clients.map((c) =>
  PairingSession.create({
    uuid: "00000000-0000-4000-8000-000000000000",
    start: new Date(0),
    privateKey: P256KeyPair.fromPrivateScalar(fromHex(c.privateKey)).unwrap(),
    random: fromHex(c.random),
  }),
);

const sessionFor = (index: number): PairingSession => {
  const session = sessions[index];
  if (session === undefined) throw new Error(`fixture references missing client ${index}`);
  return session;
};

const container = (hex: string) => fromBinary(GaiaPairingResponseContainerSchema, fromHex(hex));

describe("PairingSession (libgm pair_google.go parity)", () => {
  test.each(fixture.clients.map((c, i) => [i, c] as const))(
    "client %d: init and finish payloads are byte-identical to libgm PreparePayloads",
    (i, c) => {
      const session = sessionFor(i);
      expect(toHex(session.finishPayload)).toBe(c.finishPayload);
      expect(toHex(session.initPayload)).toBe(c.initPayload);
    },
  );

  test("create() without overrides builds a well-formed CLIENT_INIT committing to CLIENT_FINISH", () => {
    const session = PairingSession.create();
    expect(session.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const message = fromBinary(Ukey2MessageSchema, session.initPayload);
    expect(message.messageType).toBe(Ukey2Message_Type.CLIENT_INIT);
    const init = fromBinary(Ukey2ClientInitSchema, message.messageData);
    expect(init.version).toBe(1);
    expect(init.random.length).toBe(32);
    expect(init.nextProtocol).toBe("AES_256_CBC-HMAC_SHA256");
    expect(init.cipherCommitments).toHaveLength(1);
    expect(init.cipherCommitments[0]?.handshakeCipher).toBe(Ukey2HandshakeCipher.P256_SHA512);
    const commitment = init.cipherCommitments[0]?.commitment ?? new Uint8Array();
    expect(toHex(commitment)).toBe(createHash("sha512").update(session.finishPayload).digest("hex"));
  });

  test("create() rejects a random override that is not 32 bytes", () => {
    expect(() => PairingSession.create({ random: new Uint8Array(31) })).toThrow();
  });

  describe("processServerInit + deriveRequestCrypto", () => {
    test.each(fixture.serverInits.map((s) => [s.name, s] as const))("%s", (_, s) => {
      const result = PairingSession.processServerInit(sessionFor(s.client), container(s.container));
      expect(result.isOk()).toBe(true);
      const { emoji, nextKey } = result.unwrap();
      expect(emoji).toBe(s.emoji);
      expect(toHex(nextKey)).toBe(s.nextKey);
      const keys = PairingSession.deriveRequestCrypto(nextKey, s.keyDerivationVersion).unwrap();
      expect(toHex(keys.aesKey)).toBe(s.aesKey);
      expect(toHex(keys.hmacKey)).toBe(s.hmacKey);
    });

    test("fixtures exercise both verification code and key derivation versions", () => {
      const combos = new Set(fixture.serverInits.map((s) => `${s.verificationCodeVersion}/${s.keyDerivationVersion}`));
      expect([...combos].sort()).toEqual(["0/0", "0/1", "1/0", "1/1"]);
    });
  });

  describe("rejects every server init libgm rejects", () => {
    const expectedTag: Record<string, ProcessServerInitError["_tag"]> = {
      "data is not a Ukey2Message": "Ukey2DecodeError",
      "message type CLIENT_INIT": "Ukey2UnexpectedMessageTypeError",
      "message type unset": "Ukey2UnexpectedMessageTypeError",
      "payload is not a Ukey2ServerInit": "Ukey2DecodeError",
      "version 0": "Ukey2UnexpectedVersionError",
      "version 2": "Ukey2UnexpectedVersionError",
      "cipher CURVE25519_SHA512": "Ukey2UnexpectedCipherError",
      "cipher unset": "Ukey2UnexpectedCipherError",
      "random 31 bytes": "Ukey2UnexpectedRandomLengthError",
      "random 33 bytes": "Ukey2UnexpectedRandomLengthError",
      "x prefix 1": "Ukey2ServerKeyPrefixError",
      "y prefix 0xff": "Ukey2ServerKeyPrefixError",
      "point not on curve": "Ukey2InvalidServerKeyError",
      "x overflows 256 bits": "Ukey2InvalidServerKeyError",
      "x overflows 256 bits and y prefix 1": "Ukey2ServerKeyPrefixError",
      "no public key": "Ukey2InvalidServerKeyError",
      "verification code version 2": "UnsupportedVerificationCodeVersionError",
      "verification code version -1": "UnsupportedVerificationCodeVersionError",
    };
    test.each(fixture.rejectedServerInits.map((r) => [r.name, r] as const))("%s", (name, r) => {
      const result = PairingSession.processServerInit(sessionFor(r.client), container(r.container));
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error._tag).toBe(expectedTag[name] ?? `unmapped case (Go: ${r.goError})`);
      const detail = result.error.match({
        Ukey2DecodeError: (e) => e.part,
        Ukey2UnexpectedMessageTypeError: (e) => Ukey2Message_Type[e.messageType] ?? String(e.messageType),
        Ukey2UnexpectedVersionError: (e) => `version: ${e.version}`,
        Ukey2UnexpectedCipherError: (e) => Ukey2HandshakeCipher[e.cipher] ?? String(e.cipher),
        Ukey2UnexpectedRandomLengthError: (e) => `length ${e.length}`,
        Ukey2ServerKeyPrefixError: (e) => `${e.coordinate} coordinate has unexpected prefix: ${e.prefix}`,
        Ukey2InvalidServerKeyError: () => "invalid server key",
        P256InvalidPrivateKeyError: () => "invalid our key",
        UnsupportedVerificationCodeVersionError: (e) => `version ${e.version}`,
      });
      const goDetail = detail === "Ukey2Message" ? "server init message" : detail === "Ukey2ServerInit" ? "server init payload" : detail;
      expect(r.goError).toContain(goDetail);
    });
  });

  test("deriveRequestCrypto rejects unknown key derivation versions", () => {
    const result = PairingSession.deriveRequestCrypto(new Uint8Array(32), 2);
    expect(result.isErr() && result.error._tag).toBe("UnsupportedKeyDerivationVersionError");
  });

  test.each(fixture.byteHash.map((b) => [b.input, b.hash] as const))("byteHash(%s) = %d like libgm", (input, hash) => {
    expect(byteHash(fromHex(input))).toBe(hash);
  });
});

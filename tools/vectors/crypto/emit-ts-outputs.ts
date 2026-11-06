// Writes TS-produced crypto outputs for `go run . verify -in <file>` to check
// against libgm. Usage (from the repo root):
//   bun tools/vectors/crypto/emit-ts-outputs.ts /tmp/openrcs-vectors/crypto/ts-outputs.json
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import aesFixture from "../../../src/lib/gm/__fixtures__/crypto-aes-ctr.json";
import jwkFixture from "../../../src/lib/gm/__fixtures__/crypto-jwk.json";
import { AesCtrHelper } from "../../../src/lib/gm/crypto/aes-ctr";
import { Jwk } from "../../../src/lib/gm/crypto/jwk";
import { PairingSession } from "../../../src/lib/gm/crypto/ukey2";

const out = process.argv[2] ?? "/tmp/openrcs-vectors/crypto/ts-outputs.json";
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

const keys: Jwk[] = [
  ...jwkFixture.cases.map((c) => Jwk.fromJson(JSON.parse(c.jwkJson)).unwrap()),
  Jwk.generate(),
  Jwk.generate(),
];
const jwk = keys.flatMap((key) =>
  [1762435200123000n, 1n].map((ts) => {
    const requestId = randomUUID();
    return {
      jwkJson: JSON.stringify(Jwk.toJson(key)),
      spki: toHex(Jwk.publicKeySpkiDer(key)),
      requestId,
      timestampMicros: ts.toString(),
      signature: toHex(Jwk.signRequest(key, requestId, ts)),
    };
  }),
);

const helper = AesCtrHelper.fromKeys(fromHex(aesFixture.aesKey), fromHex(aesFixture.hmacKey)).unwrap();
const aesCtr = {
  aesKey: aesFixture.aesKey,
  hmacKey: aesFixture.hmacKey,
  cases: [0, 1, 16, 33, 4096].map((n) => {
    const plaintext = new Uint8Array(randomBytes(n));
    return { plaintext: toHex(plaintext), ciphertext: toHex(AesCtrHelper.encrypt(helper, plaintext)) };
  }),
};

const ukey2 = [0, 1, 2, 3].map(() => {
  const random = new Uint8Array(randomBytes(32));
  const session = PairingSession.create({ random });
  return {
    privateKey: toHex(session.pairingKey.d),
    random: toHex(random),
    initPayload: toHex(session.initPayload),
    finishPayload: toHex(session.finishPayload),
  };
});

writeFileSync(out, JSON.stringify({ jwk, aesCtr, ukey2 }, null, 2));
console.log(`wrote ${out}: ${jwk.length} signatures, ${aesCtr.cases.length} ciphertexts, ${ukey2.length} ukey2 sessions`);

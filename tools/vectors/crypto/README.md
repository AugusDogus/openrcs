# crypto vectors

Go module that runs libgm to produce the parity fixtures `src/lib/gm/__fixtures__/crypto-*.json` read by `src/lib/gm/crypto/*.test.ts`, and checks TS output against libgm.

```sh
cd tools/vectors/crypto
export GOPATH=/tmp/openmessage-src/gopath GOFLAGS=-modcacherw

go run . gen    # rewrite the fixtures (see docs/architecture.md for the libgm source)

# TS -> Go: TS signs, encrypts and builds UKEY2 payloads, then libgm checks them
(cd ../../.. && bun tools/vectors/crypto/emit-ts-outputs.ts /tmp/openrcs-vectors/crypto/ts-outputs.json)
go run . verify -in /tmp/openrcs-vectors/crypto/ts-outputs.json
```

How the fixtures are made:

- Keys, plaintexts and server randoms are seeded from SHA-256 of fixed labels. AES IVs, ECDSA signatures, the client `Random` and SAPISID timestamps come from libgm's own randomness or clock, so `gen` changes those bytes on every run. That is expected.
- `crypto-aes-ctr.json`: libgm `AESCTRHelper.Encrypt`/`Decrypt`, including rejected inputs and Go's error text.
- `crypto-jwk.json`: libgm `crypto.JWK` JSON (`big.Int.Bytes()` widths, with cases where d, x or y has a leading zero byte), `x509.MarshalPKIXPublicKey`, and signatures made like `refreshAuthToken` (SHA-256, then `ecdsa.SignASN1`).
- `crypto-emoji.json`: libgm's `pairingEmojisV0`/`V1` after its `init()`, read through `go:linkname`.
- `crypto-ukey2.json`: `libgm.PairingSession` with a fixed `PairingKeyDSA`, using libgm's `PreparePayloads` as is. The random it picked is parsed back out of `InitPayload` and recorded, so nothing is post-processed. The server side is synthetic: a fixed server P-256 key builds a `Ukey2ServerInit`, wrapped in a `GaiaPairingResponseContainer`, for each verification code version (0, 1) and key derivation version (0, 1), 64 cases each, plus coordinate-encoding variants. These go to libgm's `ProcessServerInit` (emoji, `NextKey`). The request keys come from a copy of `FinishGaiaPairing`'s derivation block that calls libgm's own `doHKDF`, `byteHash` and `encryptionKeyInfo` through `go:linkname`. Rejected server inits record libgm's error text.
- `crypto-sapisid.json`: `libgm.SAPISIDHash`, with the timestamp it used parsed back out of the output.

# client vectors

Go module that runs libgm's own client code to produce `src/lib/gm/__fixtures__/client.json`, read by `src/lib/gm/parity.test.ts` (byte-for-byte request and frame parity).

```sh
cd tools/vectors/client
GOPATH=/tmp/openmessage-src/gopath GOFLAGS=-modcacherw go run .   # rewrites the fixture (see docs/architecture.md for the libgm source)
```

How it works:

- A real `libgm.Client` gets a recording `http.RoundTripper` in its unexported `http`/`lphttp` fields (set through `reflect` + `unsafe`); nothing else in libgm is changed. Requests are captured exactly as libgm builds them and answered with canned responses (the long poll answers 401, or `[[` and then blocks, so the calls return).
- Exported methods drive it (`StartLogin`, `RefreshPhoneRelay`, `SetActiveSession`, the RPC methods with a 1 ms request timeout, `HandleRPCMsg`, `ConnectBackground` for the ack request, `UnpairBugle`, `StartGaiaPairing` with a short context for CLIENT_INIT + CANCEL, `FinishGaiaPairing` cancelled mid-wait for CLIENT_FINISHED + CANCEL, `UnpairGaia`). `refreshAuthToken` and `decryptInternalMessage` are called through `go:linkname`.
- Keys and tokens are seeded from SHA-256 of fixed labels and `uuid.SetRand` is seeded. Values libgm draws itself (AES IVs, ECDSA signatures, timestamps, the Gaia attempt start time) are recorded from the captured requests and fed back into the TS builders, so `gen` changes those bytes on every run; that is expected. TS verifies libgm's refresh signature with its own public key instead of comparing signature bytes.
- `buildSendPayloadWithTmpID` and `newContactNumbers` are verbatim copies of openmessage `internal/app/gm.go` (an `internal` package cannot be imported from here).
- Incoming frames are built with libgm's `AESCTRHelper.Encrypt` and Go pblite, decoded by libgm's `decryptInternalMessage`, and fed to `HandleRPCMsg`; the fixture records the decrypted bytes, the decoded response (deterministic proto marshal), the response shape and the events libgm emitted.
- `acceptance.go` registers a waiter with libgm's `waitResponse` and records what `receiveResponse` does with each frame (consumed, delivered) for payload-less, field-5 intermediate, field-11 account and Gaia pairing frames, on a `HasCookies` session and on a Gaia session without cookies.

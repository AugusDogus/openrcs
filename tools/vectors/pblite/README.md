# pblite test vectors

Regenerates `src/lib/gm/__fixtures__/pblite.json` and `pblite-constants.json` from the Go reference (`go.mau.fi/util/pblite` and libgm).

Run from this directory, with the module cache described in `docs/architecture.md`:

```sh
GOPATH=/tmp/openmessage-src/gopath GOFLAGS=-modcacherw go run .
```

Cases marked `archDependent` or `roundTripArchDependent` depend on how Go converts out-of-range floats to integers, which differs between CPU architectures. The TS port follows amd64, and the tests skip those cases when the fixtures were generated on another architecture.

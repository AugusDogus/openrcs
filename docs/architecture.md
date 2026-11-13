# openrcs architecture

Self-hosted Google Messages (RCS/SMS) bridge with an OAuth-protected MCP
server, reachable only over Tailscale (docs/self-hosting.md). You sign in with
your Tailscale identity, pair your phone's Google Messages as a "Messages for
web" device by signing in to Google in a browser streamed into the page, and
MCP clients can then list, read, search and send messages.

The Google Messages protocol is a TypeScript port of libgm from
`mautrix-gmessages` (as forked by `MaxGhenis/gmessages`, used by
`MaxGhenis/openmessage`). Reference source (read-only, outside the repo):

- libgm: `/tmp/openmessage-src/gopath/pkg/mod/github.com/!max!ghenis/gmessages@v0.2602.1-0.20261021163109-6495a585293d/pkg/libgm`
- pblite: `/tmp/openmessage-src/gopath/pkg/mod/go.mau.fi/util@v0.9.10/pblite`
- openmessage: `/tmp/openmessage-src/openmessage` (send payloads in `internal/app/gm.go`, message extraction in `internal/client/client.go`, MCP tools in `internal/tools`)

Go 1.27 is installed. To build Go programs against libgm (e.g. to produce test
vectors), create a module under `/tmp/` that requires
`go.mau.fi/mautrix-gmessages` with the same `replace` as
`/tmp/openmessage-src/openmessage/go.mod`, and run with
`GOPATH=/tmp/openmessage-src/gopath GOFLAGS=-modcacherw`.

## Stack

- Next.js 16 App Router (Node.js runtime only), React 19, Tailwind v4
- Better Auth for Tailscale-identity sign-in and browser sessions only
- Our own OAuth 2.1 authorization server for MCP in `src/lib/oauth` (DCR,
  PKCE, refresh rotation) whose tokens carry a client-held key share; see
  docs/security.md
- MCP server: `@modelcontextprotocol/server` v2 `createMcpHandler`, behind
  our bearer-token check
- SQLite via `@libsql/client` + Drizzle ORM (`file:/data/openrcs.db` in the
  container; tests use temp files). Message content is encrypted per user (docs/security.md), so
  there is no plaintext full-text index.
- Protobuf: `@bufbuild/protobuf` v2; generated code in `src/gen/gmproto`
  (`bun run gen:proto`, never hand-edit). The custom option
  `pblite.pblite_binary` is the `pblite_binary` extension in
  `src/gen/gmproto/vendor/pblite_pb.ts` (read with `getOption(field, pblite_binary)`
  from `@bufbuild/protobuf`).
- Errors as values via `better-result` for expected failures; tagged error
  classes. Tests with `bun:test` (`bun test`).
- Deploy: one Docker image (LinuxServer's Selkies base) behind Tailscale
  Serve. nginx on 127.0.0.1:3000 fronts Next.js (127.0.0.1:3100) and the
  Selkies stream of the sign-in browser (`/pairing-browser/`).

## Directory layout

```
src/
  gen/gmproto/            generated protobuf (do not edit)
  lib/gm/                 Google Messages protocol (TS port of libgm); no Next/DB imports
    pblite.ts             pblite JSON <-> protobuf-es messages
    constants.ts          URLs, headers values, ConfigVersion, API key, UA strings
    crypto/aes-ctr.ts     AES-256-CTR + HMAC-SHA256 request crypto
    crypto/aes-gcm.ts     chunked AES-256-GCM attachment crypto
    crypto/jwk.ts         ECDSA P-256 refresh key (JWK), ASN.1 signing, SPKI export
    crypto/ukey2.ts       Gaia pairing session: UKEY2 payloads, server init, emoji, key derivation
    crypto/emoji.ts       pairing emoji tables v0/v1
    crypto/sapisid.ts     SAPISIDHASH
    auth-data.ts          AuthData type + JSON (de)serialization
    google-cookies.ts     the Google cookie map Gaia pairing needs
    http.ts               request builder + typed response decode + cookie jar updates
    longpoll.ts           ReceiveMessages stream parser
    session.ts            outgoing RPC builder, response waiters, acks
    client.ts             GMClient: connect, long poll lifecycle, RPC methods, events
    pair-gaia.ts          Google-account pairing
    pair-qr.ts            QR pairing (protocol only; the app offers Google-account pairing alone)
    message.ts            plain message/conversation extraction, send payloads
    media.ts              attachment download (libgm DownloadMedia)
    errors.ts             tagged errors
    testing/              fake Google + fake phone harness for tests
  lib/db/                 Drizzle schema + client (auth tables + app tables)
  lib/auth.ts             Better Auth server config
  lib/auth-tailscale.ts   sign-in from Tailscale Serve identity headers
  lib/pairing-browser/    the Chromium used for Google sign-in: launch, NetLog sign-in
                          detection, cookie decryption, stream authorization
  lib/vault/              split-key vault: DEK, key slots, DataBox, device unlock
  lib/oauth/              OAuth 2.1 authorization server for MCP
  lib/secret-box.ts       AES-256-GCM envelope primitive
  lib/env.ts              validated env (zod)
  lib/rcs/                service layer: phone lease, session persistence, sync, search, send, pairing,
                          attachments and their download links
  lib/mcp/                MCP server and tools (one file per tool)
  app/                    routes and pages
```

## Phone model

Nothing talks to the phone in the background. Every operation that needs the
phone runs inside one request:

1. Acquire a per-user phone lease (DB row with expiry) so only one request
   talks to the phone at a time.
2. Load the user's `AuthData` and decrypt it with the DEK unwrapped from the
   caller's key slot or access token (docs/security.md).
3. Refresh the tachyon token if it expires within 1 hour.
4. Open the `ReceiveMessages` long poll (streaming fetch), set the active
   session (`GET_UPDATES`), then issue RPCs. RPC responses arrive on the long
   poll and are matched to waiters by request ID.
5. Store any message/conversation events that arrived on the stream.
6. Persist `AuthData` changes (token, cookies), ack received messages, close
   the stream, release the lease.

Reads and search serve from the database (encrypted per user), populated by a
backfill at pairing and a throttled incremental sync whenever a client calls
in. There is no unattended background sync: the server cannot decrypt
anything without a client's key share. Sends always go to the phone.

## Security

See docs/security.md (split-key vault, OAuth design, breach analysis).

## Environment

The container sets these itself (docker/root/usr/local/bin/openrcs-start);
docs/self-hosting.md lists what you can override.

| Name | Purpose |
| --- | --- |
| `BETTER_AUTH_URL` | Public origin, e.g. `https://openrcs.example.ts.net` (also the OAuth issuer) |
| `BETTER_AUTH_SECRET` | Better Auth secret |
| `DATABASE_URL` | libSQL URL, `file:/data/openrcs.db` in the container |
| `KEY_PEPPER` | base64 32-byte server key share for the vault (docs/security.md) |

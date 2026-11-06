# openrcs architecture

Hosted Google Messages (RCS/SMS) bridge with an OAuth-protected MCP server.
A user signs in, pairs their phone's Google Messages as a "Messages for web"
device, and MCP clients (via executor.sh) can then list, read, search and send
messages.

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
- Better Auth (email + password, sign-up restricted to an allowlist) with the
  `@better-auth/mcp` plugin (OAuth 2.1 authorization server, dynamic client
  registration, JWT access tokens via the `jwt` plugin)
- MCP server: `@modelcontextprotocol/server` v2 `createMcpHandler`, wrapped by
  `requireMcpAuth` from `@better-auth/mcp`
- Turso (libSQL) via `@libsql/client` + Drizzle ORM. Local dev/tests use
  `file:` URLs. FTS5 is available on Turso.
- Protobuf: `@bufbuild/protobuf` v2; generated code in `src/gen/gmproto`
  (`bun run gen:proto`, never hand-edit). The custom option
  `pblite.pblite_binary` is the `pblite_binary` extension in
  `src/gen/gmproto/vendor/pblite_pb.ts` (read with `getOption(field, pblite_binary)`
  from `@bufbuild/protobuf`).
- Errors as values via `better-result` for expected failures; tagged error
  classes. Tests with `bun:test` (`bun test`).
- Deploy: Vercel (team `augies-projects`), Fluid compute, `iad1`.

## Directory layout

```
src/
  gen/gmproto/            generated protobuf (do not edit)
  lib/gm/                 Google Messages protocol (TS port of libgm); no Next/DB imports
    pblite.ts             pblite JSON <-> protobuf-es messages
    constants.ts          URLs, headers values, ConfigVersion, API key, UA strings
    crypto/aes-ctr.ts     AES-256-CTR + HMAC-SHA256 request crypto
    crypto/jwk.ts         ECDSA P-256 refresh key (JWK), ASN.1 signing, SPKI export
    crypto/ukey2.ts       Gaia pairing session: UKEY2 payloads, server init, emoji, key derivation
    crypto/emoji.ts       pairing emoji tables v0/v1
    crypto/sapisid.ts     SAPISIDHASH
    auth-data.ts          AuthData type + JSON (de)serialization
    http.ts               request builder + typed response decode + cookie jar updates
    longpoll.ts           ReceiveMessages stream parser
    session.ts            outgoing RPC builder, response waiters, acks
    client.ts             GMClient: connect, long poll lifecycle, RPC methods, events
    pair-gaia.ts          Google-account pairing
    pair-qr.ts            QR pairing
    errors.ts             tagged errors
  lib/db/                 Drizzle schema + client (auth tables + app tables)
  lib/auth.ts             Better Auth server config
  lib/auth-client.ts      Better Auth React client
  lib/secret-box.ts       AES-256-GCM envelope for secrets at rest (key from env)
  lib/env.ts              validated env (zod)
  lib/rcs/                service layer: phone lease, session persistence, sync, search, send
  app/                    routes and pages
```

## Serverless model

There is no long-running daemon. Every operation that needs the phone runs
inside one function invocation:

1. Acquire a per-user phone lease (DB row with expiry) so only one invocation
   talks to the phone at a time.
2. Load and decrypt the user's `AuthData`.
3. Refresh the tachyon token if it expires within 1 hour.
4. Open the `ReceiveMessages` long poll (streaming fetch), set the active
   session (`GET_UPDATES`), then issue RPCs. RPC responses arrive on the long
   poll and are matched to waiters by request ID.
5. Store any message/conversation events that arrived on the stream.
6. Persist `AuthData` changes (token, cookies), ack received messages, close
   the stream, release the lease.

Reads and search serve from Turso, populated by sync (Vercel cron plus
on-demand refresh). Sends always go to the phone.

## Security

- Google cookies and pairing keys are encrypted at rest with AES-256-GCM using
  `SESSION_ENCRYPTION_KEY` (32 random bytes, base64) from the environment.
  Never log cookies, tokens, keys or message bodies.
- Sign-up allowed only for emails in `ALLOWED_EMAILS` (comma-separated).
- MCP access requires an OAuth access token issued by this app for the MCP
  resource (`${BETTER_AUTH_URL}/api/mcp`). Each token maps to one user; tools
  only touch that user's data.
- Cron endpoints require `Authorization: Bearer ${CRON_SECRET}`.

## Environment

| Name | Purpose |
| --- | --- |
| `BETTER_AUTH_URL` | Public origin, e.g. `https://openrcs.vercel.app` |
| `BETTER_AUTH_SECRET` | Better Auth secret |
| `TURSO_DATABASE_URL` | `libsql://...` or `file:./.data/dev.db` |
| `TURSO_AUTH_TOKEN` | Turso token (unset for `file:`) |
| `SESSION_ENCRYPTION_KEY` | base64 32-byte key for secret-box |
| `ALLOWED_EMAILS` | comma-separated sign-up allowlist |
| `CRON_SECRET` | Vercel cron auth |

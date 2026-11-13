# Security model: split-key vault

Goal: a hosted server that can act on a user's Google Messages session only
while one of that user's own clients (their browser, or an MCP client they
authorized) is talking to it. A full leak of the database **and** the server's
environment secrets must not reveal any user's Google cookies, pairing keys,
or message content.

## What each breach reveals

| Attacker has | Learns |
| --- | --- |
| Database dump | Opaque ids, timestamps, row counts. No secrets, no content (GitHub provider tokens are dropped before every account write, never stored). |
| Database + Vercel env (`KEY_PEPPER`) | Same as above. Every key-encryption key also needs a client-held secret that is never stored. |
| One user's live refresh token or device cookie, plus DB + env | That one user's data. Used, rotated, revoked or expired codes, refresh tokens and device cookies reveal nothing: their slot's wrapped DEK is destroyed. |
| Any access token ever issued to a user, plus env (`KEY_PEPPER`) | That user's DEK, so with the DB their data, until the DEK is rotated (re-pairing from a browser with no valid device slot). Expiry and revocation stop the server honoring the token but cannot take back the DEK it carries. |
| A live compromise of the running code | Data of users whose clients make requests during the compromise. No hosted design can prevent this; only running locally can. |

The unavoidable trade-off: the server cannot sync while no client is
connected, so there is no unattended background sync. Instead, a large backfill
runs at pairing, and an incremental sync runs (throttled) whenever an MCP
client or the dashboard calls in.

## Key hierarchy

- **DEK** (data encryption key): 32 random bytes per user, created at first
  pairing. Encrypts the user's `AuthData` (Google cookies, pairing keys,
  tokens) and every piece of message/conversation content. Never stored
  unwrapped; exists only in memory during a request.
- **Key slots**: copies of the DEK wrapped with AES-256-GCM under a
  key-encryption key (KEK). For each slot:
  `KEK = HKDF-SHA256(ikm = slotSecret, salt = KEY_PEPPER, info = "openrcs/kek/v1|" + kind + "|" + slotId)`.
  `slotSecret` is 32 random bytes held only by the client. The DB stores the
  slot id, kind, `verifier = SHA-256(HKDF(slotSecret, salt = KEY_PEPPER, info = "openrcs/verifier/v1|" + slotId))`,
  the wrapped DEK (AAD = `userId|kind|slotId|dekId`), expiry, and revocation state.
  So unwrapping needs three things: the DB row, the env pepper, and the
  client's secret. When a slot stops being usable (a code is redeemed, a
  refresh token rotated, a slot revoked, or an expired slot is presented or
  swept on the user's next token or consent write) its wrapped DEK is
  overwritten with an empty tombstone. The row (id, verifier, grant,
  consumed/revoked times) stays for replay detection.
- Slot kinds:
  - `device`: the browser that paired. Its secret lives in an HttpOnly,
    Secure, SameSite=Lax cookie `__Host-openrcs-device-<tag>` = `<slotId>.<base64url secret>`
    (1 year), where `<tag>` is the first 16 characters of
    base64url(SHA-256(userId)): one cookie per account, so accounts sharing
    a browser never overwrite each other's key. (The unscoped
    `__Host-openrcs-device` of browsers paired earlier is still read, and only
    unlocks its own account.) Lets the dashboard unlock data and approve new
    MCP clients.
  - `oauth_code`: an authorization code (single use, 60 s TTL). The code
    string itself carries the secret.
  - `oauth_refresh`: a refresh token (rotated on every use). The token string
    carries the secret.
- **Access tokens** are stateless sealed envelopes:
  `"oat_" + AES-256-GCM(key = HKDF(KEY_PEPPER, info = "openrcs/access-token/v1"), JSON{v, uid, gid, cid, scope, exp, did, dek})`
  (`did` is the DEK id).
  They are never stored server-side, live 1 hour, and are checked against the
  grant row (not revoked) on every request. Because the DEK is inside, any
  access token ever issued (even expired or revoked) plus the env pepper
  gives the DEK, and that DEK stays valid until the user's DEK is rotated by
  re-pairing from a browser with no valid device slot. Revoking a grant does
  not rotate the DEK (that would disconnect every other client).

## Data at rest

Encrypted with the DEK (`DataBox`, AES-256-GCM, versioned envelope, AAD binds
user id, table and row key so ciphertexts cannot be swapped between rows or
users): `gm_session.auth_data_enc`; conversation name, participants and last
message preview; message body, sender name/number, media metadata and
reactions (media metadata includes the attachment's own decryption key, see
"Attachments"). Plaintext: user id, Google's opaque conversation/message ids,
timestamps, from-me flag, delivery status, unread/read-only/group flags.

Search decrypts candidate rows in memory (filtered first by user, optional
conversation, and time window in SQL), newest first, with a scan cap that the
result reports when hit. There is no plaintext full-text index.

## Attachments

Google stores each attachment encrypted under a key that travels inside its
message. openrcs keeps that key with the message's media metadata, inside
the DEK-sealed content, and never stores attachment bytes. The `get_media`
tool (scope `messages:read`, read-only) downloads from Google with the
session's tachyon token and decrypts in memory. When Google only holds a
reduced-size preview, it first asks the phone to upload the original
(libgm `GetFullSizeImage`), which changes nothing the user can see. `get_messages` and
`search_messages` never return the key.

Attachments that are not returned inline get a download link,
`/api/media/<id>.<secret>`, valid for 10 minutes. The link is a bearer
capability for that one file, because the person or tool that fetches it has
no access token. The row behind it (`media-link:<id>` in the `verification`
table) holds the media id, the attachment key and the tachyon token, sealed
with `HKDF(secret, salt = KEY_PEPPER, info = "openrcs/media-link/v1")`. The
secret exists only in the link, so the database, the pepper, or both do not
open a row; a link plus the pepper and the row does, until the row expires.
Expired rows are refused and deleted when the next link is created. Request
logs contain link paths, so a log reader can download a file within those 10
minutes. Downloads are always served as attachments (`Content-Disposition:
attachment`, `nosniff`, a sandboxing CSP), never rendered on this origin.

## OAuth 2.1 authorization server for MCP

Implemented in `src/lib/oauth` (Better Auth is only used for GitHub sign-in
and browser sessions). Follows the MCP authorization spec:

- `GET /.well-known/oauth-protected-resource` (and the `/api/mcp` suffixed
  alias): RFC 9728 metadata, `resource = ${origin}/api/mcp`,
  `authorization_servers = [origin]`.
- `GET /.well-known/oauth-authorization-server` (also served at
  `/.well-known/openid-configuration` for clients that probe it): RFC 8414.
- `POST /oauth/register`: RFC 7591 dynamic client registration, open, so
  bounded: per-address limit (IPv6 counted per /64), a global hourly cap,
  URIs of at most 512 characters, and registrations without a grant are
  pruned after 24 hours.
- `GET /oauth/authorize` -> GitHub sign-in if needed -> consent page that
  requires an unlocked device slot -> authorization code. Invalid requests
  get an error page, never an automatic redirect: every redirect URI comes
  from open registration, so redirecting errors would make the issuer an
  open redirector (RFC 9700 section 4.11.2). Only the user's own consent
  decision (approve or deny) redirects to the client.
- `POST /oauth/token`: `authorization_code` (PKCE S256 required, exact
  redirect URI match, RFC 8707 `resource` must be the MCP resource) and
  `refresh_token` (rotation; reuse of a rotated token outside a short grace
  window revokes the whole grant). A redeemed code replayed by its own client
  within 10 minutes revokes the grant; replays by other clients or later
  only fail, so an old code from browser history cannot disconnect the user.
  Token requests are rate limited per address and per (client, address),
  since client ids are public.
- `POST /oauth/revoke`: RFC 7009.
- `/api/mcp` answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`
  and 403 `insufficient_scope` when a tool needs a scope the token lacks.

Scopes: `messages:read`, `messages:send`.

## Re-pairing and key loss

- Re-pairing from the paired browser (device slot valid) keeps the DEK, so
  existing MCP grants keep working.
- Re-pairing from a browser with no valid device slot creates a new DEK: all
  old slots and grants are revoked and the user's old encrypted data is
  deleted (it is unreadable without the old DEK).
- Unpair / delete deletes the session, all slots and grants, and all stored
  conversations and messages. It first takes the phone lease (waiting up to
  30 s for a sync, send or pairing in progress, else refusing and deleting
  nothing), so no in-flight operation can store rows or re-create the session
  afterwards.

## Operational rules

- Never log cookies, tokens, slot secrets, DEKs, message content, names, or
  phone numbers.
- `KEY_PEPPER` is 32 random bytes (base64). Rotating it makes every slot and
  access token unusable (users re-pair and re-authorize).
- Self-hosted (docs/self-hosting.md), sign-in instead trusts the
  `Tailscale-User-Login` header that Tailscale Serve sets, so the server must
  listen on loopback only. `KEY_PEPPER` then lives in the data folder beside
  the database: a copy of that folder is the "database and environment" row
  of the breach table, and still decrypts nothing without a client's secret.
- Self-hosted, the sign-in browser (src/lib/pairing-browser) holds a live
  Google session while it is open: its profile is in RAM (`/dev/shm`), the
  stream is served only after openrcs authorizes the request (the signed-in
  user who opened it, while it is open, at most 15 minutes), and the profile
  is deleted as soon as the cookies are read. The cookies then go only into
  the DEK-sealed session, as with a pasted cURL command; captured cookies
  nobody pairs with are dropped from memory after 5 minutes.
- On the hosted deployment sign-in is GitHub only, open to anyone. The app is AGPL-3.0 (it ports
  libgm from mautrix-gmessages). The self-hosted build has no source link in the UI: whoever runs it
  got it from the repository. A public deployment of a modified copy must still offer its source to
  users (AGPL-3.0 section 13).

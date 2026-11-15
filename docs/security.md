# Security model

openrcs runs on its owner's own box and is reachable only over their tailnet
(docs/self-hosting.md). It encrypts every user's data at rest, but the server
holds what it needs to decrypt it: that is what lets it sync in the
background, show the dashboard in any browser, and let any signed-in browser
approve agents. Whoever has a full copy of the data folder (database plus the
generated secrets) can read every stored message, so back it up encrypted or
keep it private.

## What each breach reveals

| Attacker has | Learns |
| --- | --- |
| Database dump alone | Opaque ids, timestamps, row counts and flags. No content, cookies or keys: every DEK is wrapped under a key derived from `KEY_PEPPER`. |
| Database + `KEY_PEPPER` (a copy of the whole data folder) | Every user's messages, conversation names, participants and numbers, attachment keys, and the Google Messages session (cookies and pairing keys), which can act as the paired web device until the user unpairs or Google signs it out. With network access to openrcs it could also forge access tokens for live grants. |
| One refresh or access token | That grant's scopes through `/api/mcp` (from the tailnet) until the token expires or the grant is revoked. Tokens carry no key material. |
| A live compromise of the running server | Everything, at any time: the server decrypts without any client. |

## Key hierarchy

- **DEK** (data encryption key): 32 random bytes per user, created at the
  first pairing. Encrypts the user's `AuthData` (Google cookies, pairing keys,
  tokens) and every piece of message/conversation content.
- **Server key**: the only stored copy of the DEK, one `user_key` row per
  user (src/lib/vault/server-key.ts):
  `KEK = HKDF-SHA256(ikm = KEY_PEPPER, salt = "", info = "openrcs/server-kek/v1|" + JSON[userId, dekId])`,
  `wrapped_dek = AES-256-GCM(KEK, DEK, AAD = JSON["openrcs/user-key", userId, dekId])`
  in a versioned envelope (`s1`). The KEK and AAD bind the row to its user
  and DEK id, so a row copied to another user or relabelled does not open.
  The server unwraps it whenever it needs the user's data: background sync,
  the dashboard, MCP tools.
- **OAuth credentials** (rows in `key_slot`, a name kept from when slots also
  wrapped a DEK): authorization codes `oac_<slotId>.<secret>` (single use,
  60 s) and refresh tokens `ort_<slotId>.<secret>` (rotated on every use, 90
  days). The database keeps only
  `verifier = SHA-256(HKDF(secret, salt = KEY_PEPPER, info = "openrcs/verifier/v1|" + slotId))`,
  the grant, a non-secret payload for codes, expiry, and consumed/revoked
  times. Used rows stay for replay detection.
- **Access tokens** are stateless sealed envelopes:
  `"oat_" + AES-256-GCM(key = HKDF(KEY_PEPPER, info = "openrcs/access-token/v1"), JSON{v, uid, gid, cid, scope, exp})`.
  They are never stored server-side, live 1 hour, and are checked against
  the grant row (not revoked, same user and client) on every request. Tokens
  issued before the server key also carry `did` and `dek` (a copy of the DEK
  of that time); they are still accepted and those claims are ignored. That
  old DEK opens nothing: the data sealed under it was deleted when openrcs
  moved to the server key.

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

Implemented in `src/lib/oauth` (Better Auth is only used for Tailscale-identity
sign-in and browser sessions). Follows the MCP authorization spec:

- `GET /.well-known/oauth-protected-resource` (and the `/api/mcp` suffixed
  alias): RFC 9728 metadata, `resource = ${origin}/api/mcp`,
  `authorization_servers = [origin]`.
- `GET /.well-known/oauth-authorization-server` (also served at
  `/.well-known/openid-configuration` for clients that probe it): RFC 8414.
- `POST /oauth/register`: RFC 7591 dynamic client registration, open, so
  bounded: per-address limit (IPv6 counted per /64), a global hourly cap,
  URIs of at most 512 characters, and registrations without a grant are
  pruned after 24 hours.
- `GET /oauth/authorize` -> sign-in if needed -> consent page (any
  signed-in browser of the user approves their own clients) ->
  authorization code. Invalid requests
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

- Re-pairing, from any browser, reuses the user's server key, so stored
  messages stay readable. Grants are not tied to a DEK, so connected agents
  stay connected.
- When the user has no server key (first pairing, after unpairing, or a key
  that no longer opens because `KEY_PEPPER` changed), pairing mints a new DEK
  and first deletes anything stored under an older key.
- Unpair / delete stops a running first sync, then takes the phone lease
  (waiting up to 30 s for a sync, send or pairing in progress, else refusing
  and deleting nothing), so no in-flight operation can store rows or
  re-create the session afterwards. It then deletes the session, the server
  key, all OAuth credentials and grants, and all stored conversations and
  messages.

## Operational rules

- Never log cookies, tokens, slot secrets, DEKs, message content, names, or
  phone numbers.
- `KEY_PEPPER` is 32 random bytes (base64). Rotating it makes every server
  key, refresh token and access token unusable (users re-pair, which deletes
  their stored messages, and re-authorize their agents).
- Sign-in trusts the `Tailscale-User-Login` header that Tailscale Serve sets
  (docs/self-hosting.md), so nginx listens on loopback only. `KEY_PEPPER`
  lives in the data folder beside the database: a copy of that folder is the
  "database + `KEY_PEPPER`" row of the breach table and reveals everything.
  Back it up encrypted, or keep it where only you can read it.
- The sign-in browser (src/lib/pairing-browser) holds a live
  Google session while it is open: its profile is in RAM (`/dev/shm`), the
  stream is served only after openrcs authorizes the request (the signed-in
  user who opened it, while it is open, at most 15 minutes), and the profile
  is deleted as soon as the cookies are read. The cookies then go only into
  the DEK-sealed session; captured cookies nobody pairs with are dropped from
  memory after 5 minutes.
- The app is AGPL-3.0 (it ports libgm from mautrix-gmessages). There is no
  source link in the UI: whoever runs it got it from the repository. Offering
  a modified copy to other people over a network still means offering them
  its source (AGPL-3.0 section 13).

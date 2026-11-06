<img src="assets/icon.svg" width="64" height="64" alt="">

# openrcs

A hosted bridge from your Android phone's Google Messages (SMS/RCS) to AI
agents. Sign in with GitHub, pair your phone as a "Messages for web" device,
then connect an MCP client (Claude Code, Claude Desktop, Cursor, executor.sh)
to list, read, search and send your messages.

The Google Messages protocol is a TypeScript port of libgm from
[mautrix-gmessages](https://github.com/mautrix/gmessages). The app is
AGPL-3.0.

- Next.js 16 (App Router, Node.js runtime), Tailwind v4, deployed on Vercel
- Better Auth for GitHub sign-in; our own OAuth 2.1 server for MCP clients
- MCP server built with `@modelcontextprotocol/server`
- Turso (libSQL) + Drizzle ORM; message content encrypted per user

See [docs/architecture.md](docs/architecture.md) for the serverless phone
model and directory layout.

## Security model

openrcs is designed so that a full leak of the database **and** the server's
environment secrets reveals no Google cookies, pairing keys or message content.

- Each user has a random data encryption key (DEK). It encrypts the stored
  Google session and every conversation and message (AES-256-GCM, bound to the
  owning user and row).
- The DEK is never stored unwrapped. Copies are wrapped under keys derived from
  a secret that only a client holds (your paired browser's device cookie, or
  an MCP client's OAuth refresh token) combined with the server's `KEY_PEPPER`.
- So the server can only act while one of your clients is talking to it. There
  is no unattended background sync: a large backfill runs at pairing, and an
  incremental sync runs (at most once a minute) whenever an agent or the
  dashboard calls in.
- Unpairing or deleting the account deletes the session, every key slot and
  grant, and all stored messages.

Read [docs/security.md](docs/security.md) for the key hierarchy, OAuth design
and what each kind of breach reveals.

## Pairing your phone

Open the dashboard and choose **Pair your phone**. Keep the phone on and
online. Pair from the browser you will keep using: it holds your key, so a
different browser can only re-pair (which resets stored messages and
disconnects agents).

openrcs pairs with your Google account:

1. On a computer, open [messages.google.com/web](https://messages.google.com/web)
   in Chrome, signed in to the Google account your phone's Google Messages uses.
2. Open DevTools (F12) > Network and reload the page.
3. Right-click any request to `messages.google.com` > Copy > Copy as cURL.
4. Paste it into openrcs and start pairing.
5. Tap the emoji openrcs shows in the prompt on your phone.

The cookies are encrypted with your key as described above, but Google cookies
grant broad access to your Google account.

After pairing, openrcs syncs your recent conversations (up to about four
minutes); the rest syncs incrementally later.

## Connecting an agent

The MCP endpoint is `https://<your-deployment>/api/mcp` (shown on the
dashboard with copy buttons). Agents sign in with OAuth: the client opens
openrcs in your browser and you approve it from the browser that paired your
phone. There are no API keys.

- **Claude Code**: `claude mcp add --transport http openrcs https://openrcs.vercel.app/api/mcp`
- **Claude Desktop, Cursor and other JSON-configured clients**:

  ```json
  { "mcpServers": { "openrcs": { "url": "https://openrcs.vercel.app/api/mcp" } } }
  ```

- **executor.sh**: add a remote MCP service with the URL and approve the OAuth
  sign-in.

Tools: `get_status`, `list_conversations`, `get_messages`, `search_messages`,
`send_message`, `list_contacts`, `sync_messages`. Scopes: `messages:read` for
reading, `messages:send` for sending.

## Local development

Requires [Bun](https://bun.sh) 1.4+ and a GitHub OAuth app whose callback URL is
`http://localhost:3000/api/auth/callback/github`.

```sh
bun install
cp .env.example .env.local
```

| Variable | Value for local dev |
| --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from your GitHub OAuth app |
| `TURSO_DATABASE_URL` | `file:./.data/dev.db` |
| `TURSO_AUTH_TOKEN` | leave empty |
| `KEY_PEPPER` | `openssl rand -base64 32` (must decode to 32 bytes) |

```sh
bun run db:migrate
bun run dev
```

Over `http://localhost` the device cookies are named `__openrcs-device-<tag>`
(one per account; the `__Host-` prefix needs HTTPS).

| Script | What it does |
| --- | --- |
| `bun run dev` | Next dev server |
| `bun run build` / `bun run start` | Production build / server |
| `bun run typecheck` | Route type generation + `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun test` | Unit tests (`bun:test`, temp databases with the real migrations) |
| `bun run db:migrate` | Apply `drizzle/` migrations to `TURSO_DATABASE_URL` |
| `bun run gen:proto` | Regenerate `src/gen/gmproto` from `proto/` |

## Deploying (Vercel + Turso)

1. Create a Turso database and token: `turso db create openrcs` and
   `turso db tokens create openrcs`.
2. Create a GitHub OAuth app with callback
   `https://<your-domain>/api/auth/callback/github`.
3. Set every variable above in the Vercel project. `BETTER_AUTH_URL` must be
   the public origin: it is the OAuth issuer and the MCP resource, so changing
   it invalidates issued tokens.
4. Apply migrations from your machine:
   `TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:migrate`.
5. Deploy. Functions run in `iad1` (see `vercel.json`); the pairing route allows
   up to 300 s. There are no cron jobs.

Keep `KEY_PEPPER` stable and secret: rotating it makes every key slot and
access token unusable, so every user must re-pair and re-authorize.

<img src="assets/icon.svg" width="64" height="64" alt="">

# openrcs

A bridge from your Android phone's Google Messages (SMS/RCS) to AI agents,
running on your own box and reachable only over your tailnet. Pair your phone
as a "Messages for web" device, then connect an MCP client (Claude Code,
Claude Desktop, Cursor, executor.sh) to list, read, search and send your
messages.

The Google Messages protocol is a TypeScript port of libgm from
[mautrix-gmessages](https://github.com/mautrix/gmessages). The app is
AGPL-3.0.

- Next.js 16 (App Router, Node.js runtime), Tailwind v4
- Sign-in with your Tailscale identity (Better Auth); our own OAuth 2.1 server
  for MCP clients
- MCP server built with `@modelcontextprotocol/server`
- SQLite (libSQL) + Drizzle ORM; message content encrypted per user
- A Chromium streamed into the pairing page with
  [Selkies](https://github.com/selkies-project/selkies) for Google sign-in

See [docs/architecture.md](docs/architecture.md) for the phone model and
directory layout.

## Running it

One container on any Docker host (Unraid, a NAS, a VPS), behind Tailscale
Serve. Secrets are generated into the data volume on first start, never baked
into the image.

```sh
cp .env.selfhost.example .env      # set OPENRCS_URL and TS_AUTHKEY
docker compose up -d --build
```

Then open `https://openrcs.<your-tailnet>.ts.net` from a tailnet device. Full
guide, including the Unraid template (`unraid/openrcs.xml`), tailnet access
rules, backups and troubleshooting: [docs/self-hosting.md](docs/self-hosting.md).

## Pairing your phone

Until a phone is paired, openrcs is the pairing page:

1. Sign in to Google in the browser on the page, with the account your phone's
   Google Messages uses. That browser runs in the container; openrcs keeps only
   the Google cookies it needs and deletes the rest.
2. Tap the emoji openrcs shows in the prompt on your phone.

Keep the phone on and online. Pair from the browser you will keep using: it
holds your key, so a different browser can only re-pair (which resets stored
messages and disconnects agents). After pairing, openrcs syncs your recent
conversations (up to about four minutes); the rest syncs incrementally later.

## Connecting an agent

The MCP endpoint is `https://openrcs.<your-tailnet>.ts.net/api/mcp` (on the
dashboard with a copy button). Agents sign in with OAuth: the client opens
openrcs in your browser and you approve it from the browser that paired your
phone. There are no API keys. The agent must run on a tailnet device.

- **Claude Code**: `claude mcp add --transport http openrcs https://openrcs.<your-tailnet>.ts.net/api/mcp`
- **Claude Desktop, Cursor and other JSON-configured clients**:

  ```json
  { "mcpServers": { "openrcs": { "url": "https://openrcs.<your-tailnet>.ts.net/api/mcp" } } }
  ```

- **executor.sh**: add a remote MCP service with the URL and approve the OAuth
  sign-in.

Tools: `get_status`, `list_conversations`, `get_messages`, `get_media`,
`search_messages`, `send_message`, `list_contacts`, `sync_messages`.
`get_media` returns an image attachment as image content, and other
attachments as a download link that lasts 10 minutes. Scopes: `messages:read`
for reading, `messages:send` for sending.

## Security model

openrcs is designed so that a full copy of the data folder (database and
generated secrets) reveals no Google cookies, pairing keys or message content.

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
- Unpairing deletes the session, every key slot and grant, and all stored
  messages.

Read [docs/security.md](docs/security.md) for the key hierarchy, OAuth design
and what each kind of breach reveals.

## Development

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
cp .env.example .env.local     # fill in the two secrets
bun run db:migrate
bun test
```

Sign-in needs the identity headers Tailscale Serve adds, and pairing needs the
container's Chromium, so run the app itself with `docker compose up --build`.

| Script | What it does |
| --- | --- |
| `bun run dev` | Next dev server |
| `bun run build` / `bun run start` | Production build / server |
| `bun run typecheck` | Route type generation + `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun test` | Unit tests (`bun:test`, temp databases with the real migrations) |
| `bun run db:migrate` | Apply `drizzle/` migrations to `DATABASE_URL` |
| `bun run gen:proto` | Regenerate `src/gen/gmproto` from `proto/` |

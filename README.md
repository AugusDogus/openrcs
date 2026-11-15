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

One container on any Docker host that is on your tailnet (Unraid with the
Tailscale plugin, a NAS, a VPS), behind the host's Tailscale Serve. Secrets are
generated into the data volume on first start, never baked into the image.

```sh
cp .env.selfhost.example .env      # set OPENRCS_URL
docker compose up -d --build
tailscale serve --bg --https=5443 http://127.0.0.1:5480
```

Then open `https://<machine>.<your-tailnet>.ts.net:5443` from a tailnet device.
Full guide, including the Unraid template (`unraid/openrcs.xml`), backups and
troubleshooting: [docs/self-hosting.md](docs/self-hosting.md).

## Pairing your phone

Until a phone is paired, openrcs is the pairing page:

1. Sign in to Google in the browser on the page, with the account your phone's
   Google Messages uses. That browser runs in the container; openrcs keeps only
   the Google cookies it needs and deletes the rest.
2. Tap the emoji openrcs shows in the prompt on your phone.

Keep the phone on and online. After pairing, openrcs syncs your recent
conversations on the server (up to about four minutes; the dashboard shows the
progress), then keeps syncing in the background every minute. Re-pairing, from
any browser, keeps the stored messages and connected agents.

## Connecting an agent

The MCP endpoint is `https://<machine>.<your-tailnet>.ts.net:5443/api/mcp` (on the
dashboard with a copy button). Agents sign in with OAuth: the client opens
openrcs in your browser and you approve it while signed in. There are no API
keys. The agent must run on a tailnet device.

- **Claude Code**: `claude mcp add --transport http openrcs https://<machine>.<your-tailnet>.ts.net:5443/api/mcp`
- **Claude Desktop, Cursor and other JSON-configured clients**:

  ```json
  { "mcpServers": { "openrcs": { "url": "https://<machine>.<your-tailnet>.ts.net:5443/api/mcp" } } }
  ```

- **executor.sh**: add a remote MCP service with the URL and approve the OAuth
  sign-in.

Tools: `get_status`, `list_conversations`, `get_messages`, `get_media`,
`search_messages`, `send_message`, `list_contacts`, `sync_messages`.
`get_media` returns an image attachment as image content, and other
attachments as a download link that lasts 10 minutes. Scopes: `messages:read`
for reading, `messages:send` for sending.

## Security model

openrcs runs on your own box and is reachable only over your tailnet. It
encrypts what it stores, but the server holds the keys to decrypt it, so it
can sync with no browser or agent connected.

- Each user has a random data encryption key (DEK). It encrypts the stored
  Google session and every conversation and message (AES-256-GCM, bound to the
  owning user and row).
- The server keeps one copy of each DEK, wrapped under a key derived from
  `KEY_PEPPER`. Both live in the data folder.
- So a full copy of the data folder (database plus generated secrets) reveals
  your messages and your Google Messages session. Back it up encrypted, or
  keep it somewhere only you can read. A database file without
  `secrets/key-pepper` reveals no content.
- Unpairing deletes the session, the key, every grant and all stored
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

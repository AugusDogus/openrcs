<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="openrcs logo">
</p>

<h1 align="center">openrcs</h1>

<p align="center">
  Your Android phone's texts (SMS and RCS), available to your AI agents over MCP.<br>
  Self-hosted in one Docker container, reachable only over your tailnet.
</p>

<p align="center">
  <a href="docs/media/demo.mp4">
    <img src="docs/media/demo-preview.webp" width="800" alt="Demo: signing in to Google in the browser on the pairing page, tapping the emoji on the phone, then the dashboard syncing 58 conversations and Claude Code showing up under Agents">
  </a>
  <br>
  <sub>Pairing a phone, the first sync, and an agent connecting. <a href="docs/media/demo.mp4">MP4</a></sub>
</p>

## What it does

openrcs pairs with Google Messages on your phone the way
[Messages for web](https://messages.google.com/web/) does, keeps your
conversations synced on your own server, and exposes them as an MCP server.
Agents such as Claude Code, Codex and OpenCode can then list, read, search
and send your texts.

- **Self-hosted.** One container on a box you own (a NAS, an Unraid server, a
  VPS). Your messages are stored there, encrypted at rest, and go only to
  Google (the phone's own link) and to the agents you approve.
- **Tailnet only.** Tailscale Serve is the only way in, and your Tailscale
  identity is your sign-in. Nothing is exposed to the internet or your LAN.
- **Real Google sign-in.** Pairing opens a Chromium in the container,
  streamed into the page. You sign in to Google there and tap an emoji on
  your phone. No QR codes, no cookie copying.
- **Always in sync.** The server syncs in the background every minute, so
  agents get fresh messages without a browser open.
- **Standard OAuth for agents.** Agents sign in with OAuth 2.1 (dynamic
  client registration and PKCE) and you approve each one in your browser.
  There are no API keys. Revoke any agent from the dashboard.

```
your phone (Google Messages)
        |  Google's Messages for web servers
        v
openrcs, on your box  --  SQLite in /data, encrypted per user
        |  HTTPS over your tailnet (Tailscale Serve)
        v
your browser (dashboard)  and  your agents (MCP at /api/mcp)
```

## Quick start

You need a Docker host that is on your tailnet, with MagicDNS and HTTPS
certificates enabled in the Tailscale admin console.

```sh
git clone https://github.com/AugusDogus/openrcs && cd openrcs
cp .env.selfhost.example .env      # set OPENRCS_URL=https://<machine>.<tailnet>.ts.net:5443
docker compose up -d --build
tailscale serve --bg --https=5443 http://127.0.0.1:5480
```

Open `https://<machine>.<tailnet>.ts.net:5443` from any device on your
tailnet. The container listens on the host's loopback only, and its secrets
are generated into the data folder on first start.

**Unraid:** use the template in [`unraid/openrcs.xml`](unraid/openrcs.xml)
with the Tailscale plugin.

The [self-hosting guide](docs/self-hosting.md) covers Unraid step by step,
settings, backups, updates and troubleshooting.

## Pair your phone

Until a phone is paired, the dashboard is the pairing page:

1. Sign in to Google in the browser on the page, with the account your
   phone's Google Messages uses.
2. Tap the emoji openrcs shows in the prompt on your phone.

The dashboard then shows the first sync of your recent conversations (up to
about four minutes; keep the phone on and online). After that the server
keeps syncing in the background. Re-pairing, from any browser, keeps your
stored messages and connected agents.

## Connect an agent

The MCP endpoint is shown on the dashboard with a copy button:

```
https://<machine>.<tailnet>.ts.net:5443/api/mcp
```

The agent must run on a device in your tailnet. When it connects, it opens
openrcs in your browser and you approve it there.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http openrcs <url>`, then `/mcp` in Claude Code to sign in |
| Codex | `codex mcp add openrcs --url <url>` (run `codex mcp login openrcs` to sign in again) |
| OpenCode | `opencode mcp add openrcs --url <url>`, then `opencode mcp auth openrcs` |
| Cursor and other JSON-configured clients | `{ "mcpServers": { "openrcs": { "url": "<url>" } } }` |
| [Executor](https://executor.sh) | Import openrcs as a custom app from its MCP URL, then approve the OAuth sign-in |

### Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `get_status` | either | Whether the phone is paired, when it last synced, how much is stored |
| `list_conversations` | `messages:read` | Conversations, most recent first, optionally filtered by name or number |
| `get_messages` | `messages:read` | One conversation's messages, paged |
| `search_messages` | `messages:read` | Full-text search, optionally by conversation and date range |
| `get_media` | `messages:read` | An attachment: images inline, other files as a download link valid for 10 minutes |
| `list_contacts` | `messages:read` | Contacts from the phone, to find a number to text |
| `sync_messages` | `messages:read` | Pull more history from the phone now |
| `send_message` | `messages:send` | Send a text from your phone |

Reading and searching check the phone for new messages first and fall back
to stored messages when the phone is unreachable.

## Security model

openrcs encrypts everything it stores, and the server holds the keys, so it
can sync in the background and serve agents with no browser open.

- Each user has a random data key that encrypts their Google session and
  every conversation and message (AES-256-GCM, bound to the user and row).
- The server keeps that key wrapped under `KEY_PEPPER`, which lives in the
  data folder next to the database.
- A database file alone reveals no content. A copy of the whole data folder
  reveals everything, including the Google Messages session: back it up
  encrypted, or keep it where only you can read it.
- Sign-in trusts the identity headers Tailscale Serve adds, so the app must
  only be reachable through Serve (the compose file and Unraid template bind
  it to loopback).
- Agent tokens carry no keys and can be revoked at any time. Unpairing
  deletes the session, the key, every agent grant and all stored messages.

[docs/security.md](docs/security.md) has the key hierarchy, the OAuth design
and what each kind of breach reveals.

## Development

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
cp .env.example .env.local     # fill in the two secrets
bun run db:migrate
bun test
```

Sign-in needs the identity headers Tailscale Serve adds, and pairing needs
the container's Chromium, so run the app itself with
`docker compose up --build`.

| Script | What it does |
| --- | --- |
| `bun run dev` | Next.js dev server |
| `bun run build` / `bun run start` | Production build / server |
| `bun run typecheck` | Route type generation and `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun test` | Unit tests (`bun:test`, temp databases with the real migrations) |
| `bun run db:migrate` | Apply the `drizzle/` migrations to `DATABASE_URL` |
| `bun run gen:proto` | Regenerate `src/gen/gmproto` from `proto/` |
| `bun run demo:record` | Re-record the demo above (needs ffmpeg and `bunx playwright-core install chromium`; see `scripts/demo/record.ts`) |

Stack: Next.js 16 (App Router), React 19, Tailwind v4, Better Auth for
sign-in, an OAuth 2.1 server of its own for MCP clients,
`@modelcontextprotocol/server`, SQLite (libSQL) with Drizzle, and
[Selkies](https://github.com/selkies-project/selkies) to stream the sign-in
browser. [docs/architecture.md](docs/architecture.md) explains the phone
model and the directory layout.

## License

AGPL-3.0. The Google Messages protocol is a TypeScript port of libgm from
[mautrix-gmessages](https://github.com/mautrix/gmessages); see
[NOTICE](NOTICE).

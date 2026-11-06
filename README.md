<img src="assets/icon.svg" width="64" height="64" alt="">

# openrcs

A hosted bridge to your phone's Google Messages (RCS/SMS) with an
OAuth-protected MCP server. Sign in, pair your Android phone as a "Messages for
web" device, then point an MCP client at `/api/mcp` to list, read, search and
send messages.

- Next.js 16 (App Router, Cache Components), Tailwind v4
- Better Auth: email + password with an invite allowlist, plus the
  `@better-auth/mcp` OAuth 2.1 authorization server (PKCE, dynamic client
  registration, Client ID Metadata Documents, JWT access tokens)
- MCP server built with `@modelcontextprotocol/server` v2
- Turso (libSQL) + Drizzle ORM, with SQLite FTS5 for message search

See [docs/architecture.md](docs/architecture.md) for the protocol port and the
serverless phone model.

## Local setup

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Value for local dev |
| --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `TURSO_DATABASE_URL` | `file:./.data/dev.db` |
| `TURSO_AUTH_TOKEN` | leave empty |
| `SESSION_ENCRYPTION_KEY` | `openssl rand -base64 32` (must decode to 32 bytes) |
| `ALLOWED_EMAILS` | your email; comma-separate several |
| `CRON_SECRET` | `openssl rand -base64 32` |

Then create the database and start the app:

```sh
bun run db:migrate
bun run dev
```

Open http://localhost:3000, create an account with an allowlisted email, and
copy the MCP URL from the dashboard.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Next dev server |
| `bun run build` / `bun run start` | Production build / server |
| `bun run typecheck` | Route type generation + `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun test` | Unit tests (`bun:test`) |
| `bun run db:migrate` | Apply `drizzle/` migrations to `TURSO_DATABASE_URL` (`file:` or `libsql://`) |
| `bun run db:generate` | Generate a migration from schema changes in `src/lib/db/` |
| `bun run db:auth-schema` | Regenerate `src/lib/db/auth-schema.ts` after changing Better Auth plugins |
| `bun run gen:proto` | Regenerate `src/gen/gmproto` from `proto/` |

Message search uses an FTS5 table (`message_fts`) created by the hand-written
migration `drizzle/0001_message_fts.sql`; Drizzle cannot express virtual
tables, so it does not appear in the schema files.

## Connecting an MCP client

Add `${BETTER_AUTH_URL}/api/mcp` as a remote (streamable HTTP) MCP server. The
client discovers everything else:

- `POST /api/mcp` without a token returns `401` with
  `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp"`.
- Protected-resource metadata names the authorization server
  `${BETTER_AUTH_URL}/api/auth`; its metadata is served at
  `/.well-known/oauth-authorization-server[/api/auth]`,
  `/.well-known/openid-configuration[/api/auth]` and
  `/api/auth/.well-known/*`.
- Clients register with dynamic client registration
  (`/api/auth/oauth2/register`) or a Client ID Metadata Document URL, then run
  the authorization-code flow with PKCE. The user signs in and approves access
  on `/consent`.

Scopes: `messages:read`, `messages:send` (resource scopes) plus `openid`,
`profile`, `offline_access`.

## Deploying (Vercel + Turso)

1. Create a Turso database and token:
   `turso db create openrcs` and `turso db tokens create openrcs`.
2. Set all variables from `.env.example` in the Vercel project (Production and
   Preview). `BETTER_AUTH_URL` must be the deployment's public origin; it is
   the OAuth issuer and the MCP token audience, so changing it invalidates
   issued tokens.
3. Apply migrations against Turso from your machine:
   `TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:migrate`.
4. Deploy. All routes run on the Node.js runtime; `/api/mcp` allows up to
   120 s per request. The build does not need secrets.

Keep `SESSION_ENCRYPTION_KEY` stable: it encrypts stored Google sessions, and
a new key means every user must pair their phone again.

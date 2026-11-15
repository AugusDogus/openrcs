# Development

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
| `bun run demo:record` | Re-record the README demo (needs ffmpeg and `bunx playwright-core install chromium`; see `scripts/demo/record.ts`) |

Stack: Next.js 16 (App Router), React 19, Tailwind v4, Better Auth for
sign-in, an OAuth 2.1 server of its own for MCP clients,
`@modelcontextprotocol/server`, SQLite (libSQL) with Drizzle, and
[Selkies](https://github.com/selkies-project/selkies) to stream the sign-in
browser. [architecture.md](architecture.md) explains the phone model and the
directory layout.

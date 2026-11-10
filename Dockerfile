# syntax=docker/dockerfile:1
# Self-hosted openrcs (docs/self-hosting.md). No secrets are baked in: the
# build needs none, and the entrypoint reads them from the environment or
# generates them into the /data volume on first start.

FROM oven/bun:1.4.4 AS bun

FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV OPENRCS_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN bun run build \
 && bun build src/lib/db/migrate.ts --target=node --format=esm --external @libsql/client --outfile .next/standalone/migrate.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TURSO_DATABASE_URL=file:/data/openrcs.db \
    OPENRCS_MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/openrcs-entrypoint
# Starts as root so it can fix /data ownership (and so Unraid's Tailscale hook
# can run), then drops to the unprivileged `node` user before starting the app.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["openrcs-entrypoint"]
CMD ["node", "server.js"]

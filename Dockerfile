# syntax=docker/dockerfile:1
# Self-hosted openrcs (docs/self-hosting.md). No secrets are baked in: the
# build needs none, and the start script reads them from the environment or
# generates them into the /data volume on first start.
#
# Built on LinuxServer's Selkies base image so the pairing page can show a
# real Chromium for Google sign-in (src/lib/pairing-browser). nginx on
# 127.0.0.1:3000 fronts both: openrcs (Next.js on 127.0.0.1:3100) and the
# Selkies stream under /pairing-browser/, which openrcs authorizes per request.

FROM oven/bun:1.4.4 AS bun

FROM node:22-bookworm-slim AS node

FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build \
 && bun build src/lib/db/migrate.ts --target=node --format=esm --external @libsql/client --outfile .next/standalone/migrate.mjs

FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium jq \
 && apt-get autoclean \
 && rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Selkies: one locked-down window, no audio, files, sharing, printing,
# terminals or sudo. Clipboard only into the browser (paste a password).
ENV TITLE=openrcs \
    PIXELFLUX_WAYLAND=true \
    SUBFOLDER=/pairing-browser/ \
    HARDEN_DESKTOP=true \
    START_DOCKER=false \
    NO_DECOR=true \
    NO_GAMEPAD=true \
    NO_WEBCAM=true \
    NO_STEAM=true \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_UI_SHOW_CORE_BUTTONS=false \
    SELKIES_KEYBOARD_SHORTCUTS=false \
    SELKIES_SECOND_SCREEN=false \
    SELKIES_AUDIO_ENABLED=false \
    SELKIES_MICROPHONE_ENABLED=false \
    SELKIES_WEBCAM_ENABLED=false \
    SELKIES_GAMEPAD_ENABLED=false \
    SELKIES_ENABLE_SHARING=false \
    SELKIES_FILE_TRANSFERS=none \
    SELKIES_PRINTING_ENABLED=false \
    SELKIES_COMMAND_ENABLED=false \
    SELKIES_ENABLE_CLIPBOARD=in \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/data/openrcs.db \
    OPENRCS_MIGRATIONS_DIR=/app/drizzle \
    OPENRCS_PAIRING_BROWSER_DIR=/dev/shm/openrcs-browser

WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY docker/root/ /

VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

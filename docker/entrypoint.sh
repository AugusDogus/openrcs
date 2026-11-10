#!/bin/sh
# Container entrypoint for self-hosted openrcs: prepares /data, resolves the
# public URL and secrets, applies migrations, then starts the server as `node`.
set -eu

DATA_DIR=/data
SECRETS_DIR="$DATA_DIR/secrets"

fail() {
  echo "openrcs: $*" >&2
  exit 1
}

if [ "$(id -u)" = "0" ]; then
  # With Tailscale running inside this container (Unraid's "Use Tailscale"),
  # the address Serve publishes is known; otherwise OPENRCS_URL must be set.
  if [ -z "${OPENRCS_URL:-}" ] && command -v tailscale >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    dns_name="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//')"
    if [ -n "$dns_name" ]; then
      export OPENRCS_URL="https://$dns_name"
      echo "openrcs: using the Tailscale address $OPENRCS_URL"
    fi
  fi
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  chown node:node "$DATA_DIR" "$SECRETS_DIR"
  find "$DATA_DIR" -maxdepth 1 -name 'openrcs.db*' -exec chown node:node {} +
  find "$SECRETS_DIR" -type f -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

# Self-hosted installs sign in with Tailscale identity unless told otherwise.
export AUTH_PROVIDER="${AUTH_PROVIDER:-tailscale}"

[ -n "${OPENRCS_URL:-}" ] || fail "OPENRCS_URL is not set. Set it to the address people open, for example https://openrcs.<your-tailnet>.ts.net (no trailing slash)."
export BETTER_AUTH_URL="$OPENRCS_URL"

mkdir -p "$SECRETS_DIR" 2>/dev/null || fail "cannot write to $DATA_DIR. Mount a volume there that uid $(id -u) can write."

# A secret from the environment wins. Otherwise it is generated once and kept
# in the data volume, so it survives restarts and never lives in the image.
secret() {
  name="$1"
  file="$SECRETS_DIR/$2"
  eval "current=\${$name:-}"
  if [ -z "$current" ]; then
    if [ ! -s "$file" ]; then
      (umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > "$file")
      echo "openrcs: generated $name in $file. $3"
    fi
    current="$(cat "$file")"
  fi
  export "$name=$current"
}
secret KEY_PEPPER key-pepper "Back this file up with the database: without it paired sessions and stored messages cannot be decrypted."
secret BETTER_AUTH_SECRET auth-secret "Losing it only signs browsers out."

# Loopback by default: Tailscale sign-in trusts identity headers, which is
# only safe when nothing but Tailscale Serve can reach this port.
export HOSTNAME="${OPENRCS_BIND:-127.0.0.1}"
if [ "${AUTH_PROVIDER:-}" = "tailscale" ] && [ "$HOSTNAME" != "127.0.0.1" ] && [ "$HOSTNAME" != "localhost" ]; then
  echo "openrcs: WARNING: OPENRCS_BIND=$HOSTNAME with AUTH_PROVIDER=tailscale. Anything that can reach port ${PORT:-3000} directly can sign in as any tailnet user by sending a Tailscale-User-Login header. Only do this for local testing." >&2
fi

node /app/migrate.mjs || fail "database migration failed; not starting. The database file was left as it was."
exec "$@"

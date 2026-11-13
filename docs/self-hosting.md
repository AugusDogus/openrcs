# Self-hosting openrcs on your tailnet

Run openrcs on your own machine (an Unraid server, a NAS, any Docker host)
and reach it only over Tailscale. Nothing is published to the internet or to
your LAN, and there is no Vercel, Turso or GitHub app to set up.

```
agent or browser on your tailnet
        |  HTTPS, tailnet only
        v
Tailscale Serve  https://openrcs.<tailnet>.ts.net:443   (adds Tailscale-User-Login)
        |  http://127.0.0.1:3000, same network namespace
        v
openrcs container
  nginx 127.0.0.1:3000
    /                   -> openrcs (Next.js, 127.0.0.1:3100)  ->  /data
    /pairing-browser/   -> Selkies stream of the sign-in browser (only while
                           you are pairing, only for you)
```

What differs from the hosted setup:

| | Hosted (Vercel) | Self-hosted |
| --- | --- | --- |
| Sign-in | GitHub | Your Tailscale identity (`AUTH_PROVIDER=tailscale`) |
| Database | Turso | A SQLite file in `/data` |
| Secrets | Vercel env vars | Generated into `/data/secrets` on first start, or passed as env |
| Reachable from | The internet | Your tailnet only |
| Google cookies for pairing | Copy as cURL from DevTools | Sign in to Google in a browser embedded in the pairing page (cURL still works) |

Pairing, the split-key vault, the OAuth server and the MCP tools are the same
code (see [security.md](security.md)).

## How sign-in works

Tailscale Serve adds a `Tailscale-User-Login` header to every tailnet request
it proxies and removes any copy a client sent. openrcs turns that into a
normal session cookie when you press **Continue as you@example.com**. Each
tailnet user gets their own account, pairing and messages.

This is only safe when nothing but Serve can reach the app, so the container
listens on `127.0.0.1` and publishes no ports. Do not add a port mapping, and
do not set `OPENRCS_BIND` outside local testing: anything that can reach port
3000 directly could claim to be any user.

Tagged devices and Funnel visitors carry no identity, so they cannot sign in
to the dashboard. Agents do not need one: they call `/api/mcp` with the OAuth
token you approved in your browser.

## The sign-in browser

The image is built on LinuxServer's
[Selkies](https://docs.linuxserver.io/images/docker-baseimage-selkies/) base,
so the pairing page can show a real Chromium running in the container instead
of asking you for a cURL command:

1. **Sign in with Google** starts Chromium with a fresh profile in
   `/dev/shm` (RAM) and streams it into the page.
2. You sign in to Google there. Chromium runs without a debugging port,
   because Google refuses sign-in from browsers that have one.
3. Within about 30 seconds (or when you press **I've signed in**), openrcs
   reads the Google cookies from the profile on disk, closes Chromium and
   deletes the profile. It then pairs with those cookies exactly as with a
   pasted cURL command: you tap the emoji on your phone.

nginx asks openrcs before serving any part of the stream, so only the
signed-in user who opened the browser can see it, and only while it is open
(it closes itself after 15 minutes). The desktop around the browser is locked
down: no terminals, sudo, file transfer, audio, sharing or printing, and the
clipboard only pastes into the browser. Do not sign in to Messages for web in
that window; openrcs pairs by itself.

## Before you start

In the Tailscale admin console:

1. Enable MagicDNS and HTTPS certificates (DNS page). Serve needs both.
2. Note your tailnet name (`something.ts.net`). The app's address will be
   `https://openrcs.<tailnet-name>.ts.net`.
3. Optional but recommended: tag the node and limit who can reach it. In the
   access controls file:

   ```jsonc
   {
     "tagOwners": { "tag:mcp-servers": ["autogroup:admin"] },
     "grants": [
       // People and their agents may reach MCP servers on HTTPS only.
       { "src": ["autogroup:member"], "dst": ["tag:mcp-servers"], "ip": ["tcp:443"] }
     ]
   }
   ```

   This is the shape Tailscale's own example uses for agents that join a
   tailnet through [Tailscale OAuth apps](https://tailscale.com/blog/oauth-apps-ga):
   the agent's device gets access to `tag:mcp-servers` on `tcp:443` and
   nothing else.
4. For Docker Compose, create an auth key (Settings > Keys): not reusable, not
   ephemeral, with `tag:mcp-servers` if you use the tag. Unraid's built-in
   Tailscale does not need a key; you log in from a link in the container log.

## Docker Compose (any host)

```sh
git clone https://github.com/AugusDogus/openrcs && cd openrcs
cp .env.selfhost.example .env      # set OPENRCS_URL and TS_AUTHKEY
docker compose up -d --build
docker compose logs -f openrcs     # wait for "Ready"
```

Then open `https://openrcs.<tailnet-name>.ts.net` from a device on your
tailnet. The first HTTPS request can take a few seconds while Tailscale
issues the certificate.

`docker-compose.yml` starts two containers: the official `tailscale/tailscale`
image (state in `data/tailscale`, Serve configured by
`docker/tailscale/serve.json`) and openrcs, which shares its network
namespace. After the first start you can remove `TS_AUTHKEY` from `.env`; the
node key in `data/tailscale` is reused.

## Unraid

Two ways. Both keep everything under `/mnt/user/appdata/openrcs`.

### Option A: template with Unraid's built-in Tailscale (Unraid 7+)

1. Get the image onto the server. Either pull a published image, or build it
   on the server from a terminal:

   ```sh
   git clone https://github.com/AugusDogus/openrcs /mnt/user/appdata/openrcs-src
   docker build -t openrcs:local /mnt/user/appdata/openrcs-src
   ```

2. Copy `unraid/openrcs.xml` to
   `/boot/config/plugins/dockerMan/templates-user/my-openrcs.xml`.
3. Docker tab > **Add Container** > Template: **openrcs**. If you built the
   image locally, change **Repository** to `openrcs:local`.
4. Check the Tailscale section: **Use Tailscale** on, hostname `openrcs`,
   **Tailscale Serve** = Serve, port `3000`, userspace networking on, state
   directory `/data/.tailscale_state`. Leave **Tailscale Funnel** off. Do not
   add any port mappings. Keep `--shm-size=1g` in **Extra Parameters**: the
   sign-in browser needs it.
5. Apply, open the container log, and follow the
   `https://login.tailscale.com/a/...` link once to add the node to your
   tailnet. Tag it `tag:mcp-servers` in the admin console if you use the tag,
   and disable key expiry for the node.
6. Open the Tailscale WebUI link Unraid shows, or
   `https://openrcs.<tailnet-name>.ts.net`.

With this option the container finds its own address from Tailscale, so
`OPENRCS_URL` stays empty. If you later rename the node, restart the
container and re-authorize your agents: the address is the OAuth issuer.

### Option B: Docker Compose Manager plugin

Install **Docker Compose Manager** from Community Applications, add a stack
pointing at this repository's `docker-compose.yml`, set
`OPENRCS_DATA=/mnt/user/appdata/openrcs` and the other values from
`.env.selfhost.example` in the stack's `.env`, then **Compose Up**. This is
the same setup as the Docker Compose section above.

## Pair your phone and connect agents

1. Open the dashboard, press **Continue as ...**, then **Pair your phone** and
   follow the steps on that page. Pairing is the same as on the hosted
   version, and it must be done from the browser you will keep using, because
   that browser holds your key.
2. Add `https://openrcs.<tailnet-name>.ts.net/api/mcp` to an MCP client that
   runs on a tailnet device, for example:

   ```sh
   claude mcp add --transport http openrcs https://openrcs.<tailnet-name>.ts.net/api/mcp
   ```

   The client opens the consent page in your browser; approve it there.

An agent that runs in someone else's cloud can only reach this address if it
can join your tailnet (for example through a Tailscale OAuth app
integration). Otherwise use an agent on one of your own devices.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENRCS_URL` | detected when Tailscale runs in the same container, otherwise required | Public origin, no trailing slash. Also the OAuth issuer, so changing it invalidates agent tokens |
| `AUTH_PROVIDER` | `tailscale` | `github` needs `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and a public callback URL |
| `KEY_PEPPER` | generated into `/data/secrets/key-pepper` | Server key share for the vault, base64 of 32 bytes |
| `BETTER_AUTH_SECRET` | generated into `/data/secrets/auth-secret` | Signs session cookies |
| `TURSO_DATABASE_URL` | `file:/data/openrcs.db` | Any libSQL URL works |
| `OPENRCS_BIND` | `127.0.0.1` | nginx listen address. Leave it alone (see "How sign-in works") |
| `PUID` / `PGID` | `911` (Unraid template: `99` / `100`) | User and group that own `/data` and run the app |

The image contains no secrets. Values you pass as env override the generated
files.

## Backups, updates, moving

- Back up the whole data folder while the container is stopped. The database
  is useless without `secrets/key-pepper`, and both are useless without a
  client's key (your browser's device cookie or an agent's token), which is
  the point of the vault.
- Update: pull or rebuild the image and recreate the container. Migrations
  run on every start; if one fails the container exits without starting.
- Moving from the hosted version: there is no data migration. Pair again on
  the self-hosted instance and reconnect your agents; then unpair the hosted
  one.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Sign-in page says the request carried no Tailscale identity | You reached the app some way other than Serve, or from a tagged device. Use the `https://...ts.net` address from a device signed in as a user |
| Container exits with "OPENRCS_URL is not set" | Set it (Compose), or turn on Use Tailscale so it can be detected (Unraid) |
| Browser cannot open the address | Node not approved or offline in the admin console, MagicDNS or HTTPS certificates off, or your access rules do not allow `tcp:443` to it |
| Agent gets 401 after a rename | The address changed, so old tokens are for a different issuer. Remove and re-add the MCP server in the agent |
| Google says "This browser or app may not be secure" in the sign-in browser | Not expected with this image. Use **Paste a cURL command instead** and report it |
| The sign-in browser is blank | Chromium has not drawn yet or crashed; it restarts itself within a few seconds. Make sure the container has `--shm-size=1g` |
| "This browser does not hold the key" | You are in a different browser or cleared cookies. Use the original browser, or re-pair here (deletes stored messages) |

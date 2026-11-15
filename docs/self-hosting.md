# Self-hosting openrcs on your tailnet

Run openrcs on your own machine (an Unraid server, a NAS, any Docker host)
that is already on your tailnet, and reach it only over Tailscale. Nothing is
published to the internet or to your LAN.

```
agent or browser on your tailnet
        |  HTTPS, tailnet only
        v
Tailscale Serve on the host  https://<machine>.<tailnet>.ts.net:5443   (adds Tailscale-User-Login)
        |  http://127.0.0.1:5480, the host's loopback only
        v
openrcs container (its own Docker network)
  nginx :3000
    /                   -> openrcs (Next.js, 127.0.0.1:3100)  ->  /data
    /pairing-browser/   -> Selkies stream of the sign-in browser (only while
                           you are pairing, only for you)
```

Sign-in is your Tailscale identity, the database is a SQLite file in
`/data`, and secrets are generated into `/data/secrets` on first start (or
passed as env). Security design: [security.md](security.md).

## How sign-in works

Tailscale Serve adds a `Tailscale-User-Login` header to every tailnet request
it proxies and removes any copy a client sent. openrcs turns that into a
normal session cookie as soon as the sign-in page loads. Each
tailnet user gets their own account, pairing and messages.

This is only safe when nothing but Serve can reach the app. So the container
publishes its port on the host's loopback only (`127.0.0.1:5480`) and sits on
a Docker network of its own. Never publish it on another address: anything
that can reach it directly could claim to be any user.

openrcs's cookies are named `openrcs.*`, so other apps served from the same
machine name on other ports (cookies ignore ports) cannot overwrite them.

Tagged devices and Funnel visitors carry no identity, so they cannot sign in
to the dashboard. Agents do not need one: they call `/api/mcp` with the OAuth
token you approved in your browser.

## The sign-in browser

The image is built on LinuxServer's
[Selkies](https://docs.linuxserver.io/images/docker-baseimage-selkies/) base,
so the pairing page can show a real Chromium running in the container:

1. Opening openrcs with no phone paired starts Chromium with a fresh profile in
   `/dev/shm` (RAM) and streams it into the page.
2. You sign in to Google there. Chromium runs without a debugging port,
   because Google refuses sign-in from browsers that have one.
3. Google then sends the browser to Messages for web. openrcs sees that
   request in Chromium's network log (no cookies are logged) within a second
   or two, closes Chromium, reads the Google cookies from the profile on disk
   and deletes the profile. It then pairs with those cookies: you tap the
   emoji on your phone.

nginx asks openrcs before serving any part of the stream, so only the
signed-in user who opened the browser can see it, and only while it is open
(it closes itself after 15 minutes). The desktop around the browser is locked
down: no terminals, sudo, file transfer, audio, sharing or printing, and the
clipboard only pastes into the browser.

## Before you start

1. The Docker host must be on your tailnet (`tailscale up`, or the Tailscale
   plugin on Unraid).
2. In the Tailscale admin console, enable MagicDNS and HTTPS certificates (DNS
   page). Serve needs both.
3. Pick a free HTTPS port for openrcs on that machine; these steps use `5443`.
   The address will be `https://<machine>.<tailnet>.ts.net:5443`
   (`tailscale status --self` shows the machine name).

## Docker Compose (any host)

```sh
git clone https://github.com/AugusDogus/openrcs && cd openrcs
cp .env.selfhost.example .env      # set OPENRCS_URL
docker compose up -d --build
tailscale serve --bg --https=5443 http://127.0.0.1:5480
```

Then open the address from a device on your tailnet. The first HTTPS request
can take a few seconds while Tailscale issues the certificate. Serve keeps its
configuration across restarts.

## Unraid (Tailscale plugin)

1. In a terminal, get the image onto the server, either by pulling a published
   one or by building it:

   ```sh
   git clone https://github.com/AugusDogus/openrcs /mnt/user/appdata/openrcs-src
   docker build -t openrcs:local /mnt/user/appdata/openrcs-src
   docker network create openrcs
   ```

2. Copy `unraid/openrcs.xml` to
   `/boot/config/plugins/dockerMan/templates-user/my-openrcs.xml`.
3. Docker tab > **Add Container** > Template: **openrcs**. Set **OPENRCS_URL**
   to `https://<server>.<tailnet>.ts.net:5443`. If you built the image, set
   **Repository** to `openrcs:local`. Keep **Network** `openrcs` and the
   **Extra Parameters** (`--shm-size=1g`, which the sign-in browser needs, and
   `-p 127.0.0.1:5480:3000`). Leave **Use Tailscale** off: the server's own
   Tailscale serves it.
4. Apply, then in a terminal: `tailscale serve --bg --https=5443 http://127.0.0.1:5480`.
5. Open `https://<server>.<tailnet>.ts.net:5443`.

## Pair your phone and connect agents

1. Open openrcs (your Tailscale identity signs you in) and pair: sign in to
   Google in the browser on the page, then tap the emoji on your phone. The
   server keeps your key, so any of your browsers can open the dashboard later.
2. Add `https://<machine>.<tailnet>.ts.net:5443/api/mcp` to an MCP client
   that runs on a tailnet device (or to a self-hosted MCP gateway such as
   Executor on the same tailnet), for example:

   ```sh
   claude mcp add --transport http openrcs https://<machine>.<tailnet>.ts.net:5443/api/mcp
   ```

   The client opens the consent page in your browser; approve it there.

An agent that runs in someone else's cloud can only reach this address if it
can join your tailnet (for example through a Tailscale OAuth app
integration). Otherwise use an agent on one of your own devices.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENRCS_URL` | required | The Tailscale Serve address, port included, no trailing slash. Also the OAuth issuer, so changing it invalidates agent tokens |
| `KEY_PEPPER` | generated into `/data/secrets/key-pepper` | Server key every user's data key is wrapped under, base64 of 32 bytes |
| `BETTER_AUTH_SECRET` | generated into `/data/secrets/auth-secret` | Signs session cookies |
| `DATABASE_URL` | `file:/data/openrcs.db` | Any libSQL URL works |
| `OPENRCS_BIND` | `0.0.0.0` | nginx listen address inside the container. Publish the port on `127.0.0.1` only (see "How sign-in works") |
| `PUID` / `PGID` | `911` (Unraid template: `99` / `100`) | User and group that own `/data` and run the app |

The image contains no secrets. Values you pass as env override the generated
files.

## Backups, updates, moving

- Back up the whole data folder while the container is stopped. The database
  is useless without `secrets/key-pepper`, but together they decrypt every
  stored message and the Google session (docs/security.md). Keep backups
  encrypted, or somewhere only you can read.
- Update: pull or rebuild the image and recreate the container. Migrations
  run on every start; if one fails the container exits without starting.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Sign-in page says the request carried no Tailscale identity | You reached the app some way other than Serve, or from a tagged device. Use the `https://...ts.net` address from a device signed in as a user |
| Container log says "OPENRCS_URL is not set" | Set it to the Serve address, port included |
| Browser cannot open the address | `tailscale serve status` on the host does not list the port, MagicDNS or HTTPS certificates are off, or your access rules do not allow that port |
| Agent gets 401 after a rename | The address changed, so old tokens are for a different issuer. Remove and re-add the MCP server in the agent |
| Google says "This browser or app may not be secure" in the sign-in browser | Not expected with this image; please report it |
| The sign-in browser is blank | Chromium has not drawn yet or crashed; it restarts itself within a few seconds. Make sure the container has `--shm-size=1g` |

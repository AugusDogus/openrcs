/**
 * Records the README demo video (`bun run demo:record`): pairing a phone in
 * the real openrcs UI, then the dashboard's first sync and the Agents list.
 *
 * What is real and what is faked:
 * - The app is the real production build (`next build`, `next start`) on a
 *   throwaway SQLite database with throwaway secrets, signed in through the
 *   real Tailscale-identity sign-in (the headers Tailscale Serve would add).
 * - The stage shows Google's real sign-in page, recorded first at the stage's
 *   size (./google-footage.ts; nothing is submitted to Google) and played back
 *   at /pairing-browser/, where the container would stream its Chromium.
 * - The sign-in browser and the pairing stream (/api/pair/browser,
 *   /api/pair/gaia) are faked with Playwright routes; when the fake phone
 *   confirms, ./seed.ts saves the pairing with the app's own modules.
 * - The first sync's progress is set in the server's own registry by
 *   ./server-preload.mjs, which also keeps the background sync off.
 *
 * Needs ffmpeg and Playwright's Chromium (`bunx playwright-core install chromium`).
 * Writes docs/media/demo.mp4, demo-poster.webp and demo-preview.webp.
 * DEMO_SKIP_BUILD=1 reuses the existing `.next` build.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type Route } from "playwright-core";
import { GaiaRequests } from "@/lib/gm/pair-gaia";
import { PairingEvent } from "@/lib/rcs/pairing-event";
import { installCursor, Pointer, replay, type CursorZone, type Point } from "./cursor";
import { recordGoogleFootage } from "./google-footage";
import { run, startScreencast, writeFrameSequence } from "./screencast";
import { Seed } from "./seed";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT_DIR = join(ROOT, "docs/media");

/** 1280x800 video of a 1120x700 window. */
const VIEWPORT = { width: 1120, height: 700 };
const SCALE = 8 / 7;
const VIDEO = { width: 1280, height: 800 };

// Demo identities only: an example tailnet address and made-up people.
const ORIGIN = "https://tower.example-tailnet.ts.net:5443";
const IDENTITY = { login: "alex@example.com", name: "Alex Morgan" };
const GOOGLE_EMAIL = "alex.morgan.demo@gmail.com";
const PHONE_ID = "c81f2a94d03e7b52";
const EMOJI = "🦊";
const AGENT = "Claude Code";
/** What each dashboard poll of /api/sync/status sees, in order; then the sync is over. */
const SYNC_STEPS: readonly { done: number; total: number }[] = [
  { done: 7, total: 58 },
  { done: 22, total: 58 },
  { done: 41, total: 58 },
  { done: 58, total: 58 },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("demo: a loopback server has no TCP port");
  return address.port;
};

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = portOf(server);
      server.close(() => resolvePort(port));
    });
  });

const deferred = () => {
  let resolveIt = () => {};
  const promise = new Promise<void>((r) => (resolveIt = r));
  return { promise, resolve: resolveIt };
};

const waitForServer = async (url: string, server: ChildProcess) => {
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`);
    const ok = await fetch(url).then((r) => r.status < 500, () => false);
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the app did not answer at ${url}`);
};

/** The fake /api/pair/gaia event stream: a loopback server the page's request is rerouted to. */
const startPairingStream = async () => {
  let response: ServerResponse | null = null;
  const opened = deferred();
  const server: Server = createServer((_request, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.flushHeaders();
    response = res;
    opened.resolve();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${portOf(server)}/`,
    opened: opened.promise,
    emit: (event: PairingEvent) => response?.write(PairingEvent.encode(event)),
    end: () => response?.end(),
    close: () => server.close(),
  };
};

const playerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
video{display:block;width:100%;height:100%;object-fit:fill}
</style></head><body><video id="clip" src="/pairing-browser/footage.webm" muted playsinline preload="auto"></video></body></html>`;

const centerOf = async (page: Page, selector: Parameters<Page["locator"]>[0]): Promise<Point> => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`demo: ${selector} is not on the page`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const main = async () => {
  const work = mkdtempSync(join(tmpdir(), "openrcs-demo-"));
  mkdirSync(OUT_DIR, { recursive: true });
  const [appPort, controlPort] = [await freePort(), await freePort()];
  const appUrl = `http://localhost:${appPort}`;
  const control = `http://127.0.0.1:${controlPort}`;

  // Throwaway everything; Bun loaded .env.local, which these override.
  Object.assign(process.env, {
    DATABASE_URL: `file:${join(work, "demo.db")}`,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    KEY_PEPPER: randomBytes(32).toString("base64"),
  });
  run("bun", ["src/lib/db/migrate.ts"]);
  if (process.env.DEMO_SKIP_BUILD !== "1") run("bun", ["run", "build"]);

  const server = spawn(join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(appPort), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEMO_CONTROL_PORT: String(controlPort),
      NODE_OPTIONS: `--import ${join(ROOT, "scripts/demo/server-preload.mjs")}`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const pairing = await startPairingStream();
  const browser = await chromium.launch({ channel: "chromium", args: ["--force-color-profile=srgb"] });

  try {
    await waitForServer(`http://127.0.0.1:${appPort}/sign-in`, server);
    // Headless Chromium says so in its user agent, and Google then serves a
    // basic sign-in page; a normal Chrome user agent gets the real one.
    const probe = await browser.newPage();
    const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
    await probe.close();

    const context = await browser.newContext({
      baseURL: appUrl,
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: "dark",
      locale: "en-US",
      userAgent,
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: appUrl });
    await context.addInitScript(installCursor);

    // Only the app gets the identity headers Tailscale Serve adds.
    await context.route(`${appUrl}/**`, (route) =>
      route.fallback({
        headers: { ...route.request().headers(), "tailscale-user-login": IDENTITY.login, "tailscale-user-name": IDENTITY.name },
      }),
    );

    // The sign-in browser: open at once, "signed in" when the footage is over.
    const signedIn = deferred();
    let pollSeen = deferred();
    await context.route(`${appUrl}/api/pair/browser`, async (route: Route) => {
      const body: unknown = route.request().postDataJSON();
      const action = typeof body === "object" && body !== null && "action" in body ? body.action : null;
      if (action === "poll") {
        pollSeen.resolve();
        await signedIn.promise;
      }
      const status = action === "stop" ? "idle" : action === "poll" ? "signedIn" : "signingIn";
      await route.fulfill({ json: { status } }).catch(() => {});
    });
    let footage: Buffer | null = null;
    await context.route(`${appUrl}/pairing-browser/**`, (route) =>
      route.request().url().endsWith("/footage.webm")
        ? route.fulfill({ body: footage ?? Buffer.alloc(0), contentType: "video/webm" })
        : route.fulfill({ body: footage ? playerHtml : "<body style='margin:0;background:#000'>", contentType: "text/html" }),
    );
    await context.route(`${appUrl}/api/pair/gaia`, (route) => route.fallback({ url: pairing.url }));

    // The dashboard's first-sync polls each see the next step.
    let userId = "";
    let step = 0;
    const syncDone = deferred();
    await context.route(`${appUrl}/api/sync/status`, async (route) => {
      const next = SYNC_STEPS[step];
      step += 1;
      if (next) {
        await fetch(`${control}/first-sync/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify(next) });
      } else if (step === SYNC_STEPS.length + 1) {
        await Seed.finishSync(userId);
        await Seed.connectAgent(userId, AGENT);
        await fetch(`${control}/first-sync/${encodeURIComponent(userId)}`, { method: "DELETE" });
        syncDone.resolve();
      }
      await route.fallback();
    });

    // After the phone confirms, the page says so for a moment before the dashboard loads.
    let showPairedUntil = 0;
    await context.route(`${appUrl}/dashboard**`, async (route) => {
      const wait = showPairedUntil - Date.now();
      if (wait > 0 && route.request().headers().rsc === "1") await sleep(wait);
      await route.fallback();
    });

    // Sign in (Tailscale identity), land on the pairing page and measure its stage.
    const page = await context.newPage();
    await page.goto("/dashboard");
    await page.waitForURL("**/dashboard");
    const stage = page.locator('iframe[title="Google sign-in"]');
    await stage.waitFor();
    const stageBox = await stage.boundingBox();
    if (stageBox === null) throw new Error("demo: the pairing stage is not visible");
    userId = await Seed.userId(IDENTITY.login);

    // The cursor starts right of the stage and moves in.
    const start: Point = { x: stageBox.width + 110, y: stageBox.height * 0.58 };
    const recorded = await recordGoogleFootage(browser, {
      size: { width: Math.round(stageBox.width), height: Math.round(stageBox.height) },
      scale: SCALE,
      userAgent,
      email: GOOGLE_EMAIL,
      start,
      workDir: mkdtempSync(join(work, "footage-")),
    });
    footage = readFileSync(recorded.clip);

    // Fresh pairing page, now with the footage in the stage.
    pollSeen = deferred();
    await page.reload();
    await stage.waitFor();
    const player = page.frameLocator('iframe[title="Google sign-in"]').locator("video");
    await player.evaluate(
      (video: HTMLVideoElement) =>
        video.readyState >= 2 ? undefined : new Promise<void>((r) => video.addEventListener("loadeddata", () => r(), { once: true })),
    );
    const emojiImageUrl = GaiaRequests.emojiImageUrl(EMOJI);
    await page.evaluate(
      (src) => new Promise<void>((r) => Object.assign(new Image(), { onload: () => r(), onerror: () => r(), src })),
      emojiImageUrl,
    );
    await pollSeen.promise;

    const offset = { x: stageBox.x, y: stageBox.y };
    const pointer = new Pointer(page, { x: start.x + offset.x, y: start.y + offset.y });
    await pointer.jump(pointer.at);
    const zones: CursorZone[] = recorded.zones.map((zone) => ({ ...zone, x: zone.x + offset.x, y: zone.y + offset.y }));
    await page.evaluate((z) => (window.__demoCursorZones = z), zones);
    await sleep(400);

    const capture = await startScreencast(page, VIDEO);
    await sleep(200);
    const tStart = Date.now() / 1000;
    await sleep(300);

    // 1. Google sign-in, replaying the footage's cursor in step with it.
    await player.evaluate((video: HTMLVideoElement) => video.play());
    const last = await replay(page, recorded.events, recorded.t0, offset);
    await player.evaluate(
      (video: HTMLVideoElement) =>
        video.ended ? undefined : new Promise<void>((r) => video.addEventListener("ended", () => r(), { once: true })),
    );

    // 2. Signed in: openrcs contacts Google and shows the emoji to tap.
    signedIn.resolve();
    await page.mouse.up();
    await page.evaluate(() => (window.__demoCursorZones = []));
    await pointer.jump(last);
    await pairing.opened;
    const parked = pointer.move({ x: offset.x + stageBox.width + 150, y: offset.y + stageBox.height * 0.62 }, 900);
    await sleep(650);
    pairing.emit({ type: "emoji", emoji: EMOJI, emojiImageUrl });
    await parked;
    await page.getByText("Tap this emoji on your phone").waitFor();
    await sleep(2400);

    // 3. The phone confirms: the pairing is saved and the first sync starts.
    await Seed.pairPhone(userId, PHONE_ID);
    await fetch(`${control}/first-sync/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ done: 0, total: null }),
    });
    showPairedUntil = Date.now() + 900;
    pairing.emit({ type: "paired" });
    pairing.end();
    await page.getByText("Connecting to your phone").waitFor();

    // 4. Copy the MCP address while the sync runs; the agent shows up when it is done.
    await sleep(1600);
    await pointer.move(await centerOf(page, 'button:has-text("Copy")'), 1000);
    await sleep(150);
    await pointer.click();
    await syncDone.promise;
    await page.getByText(AGENT).waitFor();
    await sleep(200);
    await pointer.move({ x: pointer.at.x + 60, y: pointer.at.y + 140 }, 800);
    await sleep(1300);
    const tEnd = Date.now() / 1000;
    const frames = await capture.stop();

    // Encode: H.264 MP4, a poster and an animated preview for the README.
    const framesDir = mkdtempSync(join(work, "frames-"));
    const input = writeFrameSequence(frames, framesDir, tStart, tEnd);
    const mp4 = join(OUT_DIR, "demo.mp4");
    run("ffmpeg", [
      ...["-v", "error", "-y", ...input],
      ...["-vf", `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos:out_range=tv,format=yuv420p`, "-color_range", "tv"],
      ...["-c:v", "libx264", "-preset", "veryslow", "-crf", "20", "-tune", "animation", "-profile:v", "high"],
      ...["-movflags", "+faststart", "-an", mp4],
    ]);
    run("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-frames:v", "1", "-c:v", "libwebp", "-quality", "88", join(OUT_DIR, "demo-poster.webp")]);
    run("ffmpeg", [
      ...["-v", "error", "-y", "-i", mp4],
      ...["-vf", "fps=15", "-c:v", "libwebp_anim", "-quality", "90", "-compression_level", "6"],
      ...["-loop", "0", join(OUT_DIR, "demo-preview.webp")],
    ]);
    for (const name of ["demo.mp4", "demo-poster.webp", "demo-preview.webp"]) {
      console.log(`${name}: ${(statSync(join(OUT_DIR, name)).size / 1024).toFixed(0)} KiB`);
    }
    console.log(`duration: ${(tEnd - tStart).toFixed(1)} s`);
  } finally {
    await browser.close();
    pairing.close();
    server.kill("SIGTERM");
    rmSync(work, { recursive: true, force: true });
  }
};

await main();

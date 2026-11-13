import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Result, TaggedError } from "better-result";

import type { GoogleCookies } from "@/lib/gm/google-cookies";
import { ChromiumCookies, type ChromiumCookiesError, type ChromiumGoogleCookies } from "./chromium-cookies";
import { createSignInWatcher, NET_LOG_FILE } from "./net-log";

// The self-hosted sign-in browser (docs/self-hosting.md): a Chromium in the
// container's Selkies desktop, streamed into the pairing page. The user signs
// in to Google there. As soon as the browser reaches Messages for web (seen in
// its NetLog, see net-log.ts), openrcs closes it, which writes its cookies,
// reads the Google cookies from the profile on disk, deletes the profile, and
// pairs with those cookies. Chromium runs without a debugging port because
// Google refuses sign-in from browsers that have one.
//
// One browser per container, owned by one openrcs user at a time. State lives
// on globalThis because Next bundles each route separately.

export type ChildHandle = {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  hasExited(): boolean;
};

export type SpawnFn = (command: string, args: readonly string[]) => ChildHandle;

export type PairingBrowserConfig = {
  readonly chromiumPath: string;
  /** Parent of the throwaway profile; ideally tmpfs. */
  readonly profileRoot: string;
  readonly startUrl: string;
  /** A browser nobody finished with is closed after this long. */
  readonly idleTimeoutMs: number;
  /** Captured cookies nobody paired with are dropped after this long. */
  readonly captureTtlMs: number;
  readonly stopTimeoutMs: number;
  readonly spawn: SpawnFn;
  readonly readCookies: (cookiesPath: string) => Promise<Result<ChromiumGoogleCookies, ChromiumCookiesError>>;
  /** Whether the browser's NetLog shows it reached Messages for web (sign-in finished). */
  readonly signInSeen: (netLogPath: string) => Promise<boolean>;
  readonly now: () => number;
};

export type PairingBrowserStatus =
  | { readonly status: "idle" }
  | { readonly status: "signingIn"; readonly missing: readonly string[] }
  | { readonly status: "signedIn" };

export class PairingBrowserError extends TaggedError("PairingBrowserError")<{
  reason: "busy" | "launch" | "cookies";
  message: string;
  cause?: unknown;
}> {}

type State =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly userId: string;
      readonly child: ChildHandle;
      readonly profileDir: string;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: "captured"; readonly userId: string; readonly cookies: GoogleCookies; readonly expiresAt: number };

/** Google sign-in that lands on Messages for web, so the profile also gets its cookies. */
export const PAIRING_BROWSER_START_URL =
  "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmessages.google.com%2Fweb%2F";

const chromiumArgs = (profileDir: string, startUrl: string): string[] => [
  // Same flags as linuxserver/chromium's wrapper, minus anything automation-like.
  "--no-sandbox",
  "--test-type",
  "--password-store=basic",
  "--ozone-platform=wayland",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  `--user-data-dir=${profileDir}`,
  // Request log for sign-in detection (default capture mode: no cookies or credentials).
  `--log-net-log=${join(profileDir, NET_LOG_FILE)}`,
  "--kiosk",
  startUrl,
];

const spawnChild: SpawnFn = (command, args) => {
  const child = nodeSpawn(command, [...args], { stdio: "ignore", env: process.env });
  let done = false;
  const exited = new Promise<void>((resolve) => {
    const finish = () => {
      done = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  return { pid: child.pid, kill: (signal) => child.kill(signal), exited, hasExited: () => done };
};

const busy = () =>
  new PairingBrowserError({
    reason: "busy",
    message:
      "Another openrcs user is signing in to Google in the pairing browser right now. Wait a few minutes and try again.",
  });

type Holder = { state: State; queue: Promise<unknown> };

declare global {
  // One per server process, shared by every route bundle.
  var __openrcsPairingBrowser: Holder | undefined;
}

const holder = (): Holder => {
  globalThis.__openrcsPairingBrowser ??= { state: { kind: "idle" }, queue: Promise.resolve() };
  return globalThis.__openrcsPairingBrowser;
};

/** Run one operation at a time, so a poll never races a stop. */
const serialized = <T>(op: () => Promise<T>): Promise<T> => {
  const h = holder();
  const next = h.queue.then(op, op);
  h.queue = next.catch(() => undefined);
  return next;
};

const cookiesPath = (profileDir: string): string => join(profileDir, "Default", "Cookies");

export const createPairingBrowser = (config: PairingBrowserConfig) => {
  const h = holder();

  /** SIGTERM (Chromium writes its cookies on a clean exit), then SIGKILL after stopTimeoutMs. */
  const stopChild = async (child: ChildHandle): Promise<void> => {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forced = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), config.stopTimeoutMs);
    });
    const outcome = await Promise.race([child.exited.then(() => "exited" as const), forced]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      await child.exited;
    }
  };

  const wipe = (profileDir: string) => rm(profileDir, { recursive: true, force: true });

  /** Delete every leftover profile (the root itself may be a tmpfs mount). */
  const clearRoot = async (): Promise<void> => {
    const entries = await readdir(config.profileRoot).catch(() => []);
    await Promise.all(entries.map((entry) => wipe(join(config.profileRoot, entry))));
  };

  /** Close the browser and delete its profile; the state becomes idle. */
  const shutDown = async (): Promise<void> => {
    const state = h.state;
    if (state.kind !== "running") return;
    clearTimeout(state.timer);
    h.state = { kind: "idle" };
    await stopChild(state.child);
    await wipe(state.profileDir);
  };

  const launch = async (userId: string, profileDir: string): Promise<Result<void, PairingBrowserError>> => {
    const made = await Result.tryPromise({
      try: () => mkdir(profileDir, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        new PairingBrowserError({
          reason: "launch",
          message: "openrcs could not create the pairing browser's profile folder. Nothing was started; check the container logs.",
          cause,
        }),
    });
    if (made.isErr()) return Result.err(made.error);
    let child: ChildHandle;
    try {
      child = config.spawn(config.chromiumPath, chromiumArgs(profileDir, config.startUrl));
    } catch (cause) {
      await wipe(profileDir);
      return Result.err(
        new PairingBrowserError({
          reason: "launch",
          message: "openrcs could not start the pairing browser. Nothing was started; check the container logs.",
          cause,
        }),
      );
    }
    const timer = setTimeout(() => void serialized(shutDown), config.idleTimeoutMs);
    h.state = { kind: "running", userId, child, profileDir, timer };
    return Result.ok(undefined);
  };

  /**
   * Close the browser (Chromium writes its cookies on a clean exit) and read
   * them. Signed in: keep the cookies, delete the profile. Not yet: reopen the
   * browser on the same profile so the user can carry on.
   */
  const capture = async (
    state: Extract<State, { kind: "running" }>,
  ): Promise<Result<PairingBrowserStatus, PairingBrowserError>> => {
    clearTimeout(state.timer);
    h.state = { kind: "idle" };
    await stopChild(state.child);
    const read = await config.readCookies(cookiesPath(state.profileDir));
    if (read.isErr()) {
      await wipe(state.profileDir);
      return Result.err(new PairingBrowserError({ reason: "cookies", message: read.error.message, cause: read.error }));
    }
    if (read.value.status === "signedOut") return reopen(state, read.value.missing);
    await wipe(state.profileDir);
    h.state = {
      kind: "captured",
      userId: state.userId,
      cookies: read.value.cookies,
      expiresAt: config.now() + config.captureTtlMs,
    };
    return Result.ok({ status: "signedIn" });
  };

  /** Start the browser again on the same profile (after a crash, or a sign-in that had not finished). */
  const reopen = async (
    state: Extract<State, { kind: "running" }>,
    missing: readonly string[],
  ): Promise<Result<PairingBrowserStatus, PairingBrowserError>> => {
    clearTimeout(state.timer);
    const relaunched = await launch(state.userId, state.profileDir);
    if (relaunched.isErr()) {
      h.state = { kind: "idle" };
      await wipe(state.profileDir);
      return Result.err(relaunched.error);
    }
    return Result.ok({ status: "signingIn", missing });
  };

  const dropExpiredCapture = (): void => {
    if (h.state.kind === "captured" && h.state.expiresAt <= config.now()) h.state = { kind: "idle" };
  };

  return {
    /** Open the sign-in browser for this user (a fresh profile). Reuses one this user already has open. */
    start: (userId: string): Promise<Result<PairingBrowserStatus, PairingBrowserError>> =>
      serialized(async () => {
        dropExpiredCapture();
        const state = h.state;
        if (state.kind !== "idle" && state.userId !== userId) return Result.err(busy());
        if (state.kind === "running") return Result.ok({ status: "signingIn", missing: [] });
        if (state.kind === "captured") h.state = { kind: "idle" };
        const profileDir = join(config.profileRoot, `profile-${config.now().toString(36)}`);
        await clearRoot();
        const launched = await launch(userId, profileDir);
        return launched.isErr() ? Result.err(launched.error) : Result.ok({ status: "signingIn", missing: [] });
      }),

    /**
     * Has Google finished signing in? Yes once the browser reaches Messages for
     * web (a second or two) or its cookie file already holds the cookies
     * (Chromium writes it every 30 s). Then the browser is closed, the cookies
     * kept for `take`, and the profile deleted.
     */
    poll: (userId: string): Promise<Result<PairingBrowserStatus, PairingBrowserError>> =>
      serialized(async () => {
        dropExpiredCapture();
        const state = h.state;
        if (state.kind === "idle" || state.userId !== userId) return Result.ok({ status: "idle" });
        if (state.kind === "captured") return Result.ok({ status: "signedIn" });
        const read = await config.readCookies(cookiesPath(state.profileDir));
        if (read.isErr()) {
          return Result.err(new PairingBrowserError({ reason: "cookies", message: read.error.message, cause: read.error }));
        }
        if (read.value.status === "signedIn") return capture(state);
        if (await config.signInSeen(join(state.profileDir, NET_LOG_FILE))) return capture(state);
        // Closed or crashed before sign-in finished: reopen on the same profile.
        if (state.child.hasExited()) return reopen(state, read.value.missing);
        return Result.ok({ status: "signingIn", missing: read.value.missing });
      }),

    /** Hand the captured cookies to pairing, once. */
    take: (userId: string): Promise<GoogleCookies | null> =>
      serialized(async () => {
        dropExpiredCapture();
        const state = h.state;
        if (state.kind !== "captured" || state.userId !== userId) return null;
        h.state = { kind: "idle" };
        return state.cookies;
      }),

    /** Close the browser and forget everything, for this user only. */
    stop: (userId: string): Promise<void> =>
      serialized(async () => {
        const state = h.state;
        if (state.kind === "idle" || state.userId !== userId) return;
        if (state.kind === "captured") {
          h.state = { kind: "idle" };
          return;
        }
        await shutDown();
      }),

    /** Whether this user may see the browser stream right now (the stream proxy's auth check). */
    canView: (userId: string): boolean => h.state.kind === "running" && h.state.userId === userId,
  } as const;
};

export type PairingBrowser = ReturnType<typeof createPairingBrowser>;

/** One watcher per server bundle, so each poll reads only new NetLog bytes. */
const watchSignIn = createSignInWatcher();

/** Where the image keeps the browser's profile: RAM, wiped on every boot (docker/root). */
const DEFAULT_PROFILE_ROOT = "/dev/shm/openrcs-browser";

export const PairingBrowser = {
  /** The container's browser. OPENRCS_PAIRING_BROWSER_DIR and OPENRCS_CHROMIUM override its paths. */
  fromEnv: (env: Readonly<Record<string, string | undefined>> = process.env): PairingBrowser =>
    createPairingBrowser({
      chromiumPath: env.OPENRCS_CHROMIUM?.trim() || "/usr/bin/chromium",
      profileRoot: env.OPENRCS_PAIRING_BROWSER_DIR?.trim() || DEFAULT_PROFILE_ROOT,
      startUrl: PAIRING_BROWSER_START_URL,
      idleTimeoutMs: 15 * 60_000,
      captureTtlMs: 5 * 60_000,
      stopTimeoutMs: 5_000,
      spawn: spawnChild,
      readCookies: (path) => ChromiumCookies.readGoogle(path),
      signInSeen: watchSignIn,
      now: Date.now,
    }),
  /** Tests only: forget the shared state (does not stop a real process). */
  resetForTests: (): void => {
    const h = holder();
    if (h.state.kind === "running") clearTimeout(h.state.timer);
    h.state = { kind: "idle" };
    h.queue = Promise.resolve();
  },
} as const;

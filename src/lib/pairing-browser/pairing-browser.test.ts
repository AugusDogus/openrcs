import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { ChromiumCookiesError, ChromiumGoogleCookies } from "./chromium-cookies";
import {
  createPairingBrowser,
  PAIRING_BROWSER_START_URL,
  PairingBrowser,
  type ChildHandle,
  type PairingBrowserConfig,
} from "./pairing-browser";

const SIGNED_IN = { SID: "s", HSID: "h", SSID: "ss", APISID: "a", SAPISID: "sa" };

type FakeChild = ChildHandle & { readonly signals: NodeJS.Signals[]; exit(): void };

const fakeChild = (opts: { ignoreTerm?: boolean } = {}): FakeChild => {
  let resolve: () => void = () => undefined;
  let done = false;
  const exited = new Promise<void>((r) => {
    resolve = r;
  });
  const signals: NodeJS.Signals[] = [];
  const exit = () => {
    done = true;
    resolve();
  };
  return {
    pid: 42,
    signals,
    exited,
    exit,
    hasExited: () => done,
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL" || !opts.ignoreTerm) exit();
      return true;
    },
  };
};

let root: string;
let spawned: { command: string; args: readonly string[]; child: FakeChild }[];
/** What the profile's cookie file reads as, per call. */
let cookieReads: Result<ChromiumGoogleCookies, ChromiumCookiesError>[];
/** Whether the NetLog shows Messages for web, per call. */
let signInSeen: boolean[];
let now: number;

const signedOut = (missing = ["SID", "HSID", "SSID", "APISID", "SAPISID"]) =>
  Result.ok<ChromiumGoogleCookies>({ status: "signedOut", missing });
const signedIn = () => Result.ok<ChromiumGoogleCookies>({ status: "signedIn", cookies: { ...SIGNED_IN } });

const browser = (overrides: Partial<PairingBrowserConfig> = {}) =>
  createPairingBrowser({
    chromiumPath: "/usr/bin/chromium",
    profileRoot: root,
    startUrl: PAIRING_BROWSER_START_URL,
    idleTimeoutMs: 60_000,
    captureTtlMs: 5_000,
    stopTimeoutMs: 20,
    spawn: (command, args) => {
      const child = fakeChild();
      spawned.push({ command, args, child });
      return child;
    },
    readCookies: async () => cookieReads.shift() ?? signedOut(),
    signInSeen: async () => signInSeen.shift() ?? false,
    now: () => now,
    ...overrides,
  });

const profileOf = (args: readonly string[]): string => {
  const flag = args.find((arg) => arg.startsWith("--user-data-dir="));
  if (flag === undefined) throw new Error("no --user-data-dir");
  return flag.slice("--user-data-dir=".length);
};

beforeEach(async () => {
  PairingBrowser.resetForTests();
  root = await mkdtemp(join(tmpdir(), "openrcs-pairing-browser-"));
  spawned = [];
  cookieReads = [];
  signInSeen = [];
  now = 1_000_000;
});

afterEach(async () => {
  PairingBrowser.resetForTests();
  await rm(root, { recursive: true, force: true });
});

describe("PairingBrowser", () => {
  test("start launches Chromium without a debugging port on a fresh profile under the root", async () => {
    await mkdir(join(root, "profile-stale"));
    const status = (await browser().start("u1")).unwrap();
    expect(status).toEqual({ status: "signingIn", missing: [] });
    expect(spawned).toHaveLength(1);
    const { command, args } = spawned[0] ?? { command: "", args: [] };
    expect(command).toBe("/usr/bin/chromium");
    expect(args).toContain("--password-store=basic");
    expect(args).toContain(PAIRING_BROWSER_START_URL);
    expect(args.some((arg) => arg.includes("remote-debugging"))).toBe(false);
    expect(args).toContain(`--log-net-log=${join(profileOf(args), "netlog.json")}`);
    expect(profileOf(args).startsWith(root)).toBe(true);
    expect(await readdir(root)).toEqual([profileOf(args).slice(root.length + 1)]);
  });

  test("starting again for the same user reuses the open browser", async () => {
    const b = browser();
    await b.start("u1");
    await b.start("u1");
    expect(spawned).toHaveLength(1);
  });

  test("another user is refused while the browser is open", async () => {
    const b = browser();
    await b.start("u1");
    const second = await b.start("u2");
    expect(second.isErr() && second.error.reason).toBe("busy");
    expect(b.canView("u1")).toBe(true);
    expect(b.canView("u2")).toBe(false);
  });

  test("poll reports missing cookies, then captures once signed in: browser closed, profile deleted", async () => {
    const b = browser();
    await b.start("u1");
    const profile = profileOf(spawned[0]?.args ?? []);
    await writeFile(join(profile, "marker"), "x");
    cookieReads = [signedOut(["SAPISID"]), signedIn(), signedIn()];

    expect((await b.poll("u1")).unwrap()).toEqual({ status: "signingIn", missing: ["SAPISID"] });
    expect((await b.poll("u1")).unwrap()).toEqual({ status: "signedIn" });
    expect(spawned[0]?.child.signals).toEqual(["SIGTERM"]);
    expect(existsSync(profile)).toBe(false);
    expect(b.canView("u1")).toBe(false);

    expect(await b.take("u2")).toBeNull();
    expect(await b.take("u1")).toEqual(SIGNED_IN);
    expect(await b.take("u1")).toBeNull();
  });

  test("reaching Messages for web closes the browser at once and captures its cookies", async () => {
    const b = browser();
    await b.start("u1");
    const profile = profileOf(spawned[0]?.args ?? []);
    // On disk the cookies are not written yet; the clean exit writes them.
    cookieReads = [signedOut(), signedIn()];
    signInSeen = [true];
    expect((await b.poll("u1")).unwrap()).toEqual({ status: "signedIn" });
    expect(spawned[0]?.child.signals).toEqual(["SIGTERM"]);
    expect(existsSync(profile)).toBe(false);
    expect(await b.take("u1")).toEqual(SIGNED_IN);
  });

  test("if the cookies are still missing after closing, the browser reopens on the same profile", async () => {
    const b = browser();
    await b.start("u1");
    cookieReads = [signedOut(), signedOut(["SID"])];
    signInSeen = [true];
    expect((await b.poll("u1")).unwrap()).toEqual({ status: "signingIn", missing: ["SID"] });
    expect(spawned).toHaveLength(2);
    expect(profileOf(spawned[1]?.args ?? [])).toBe(profileOf(spawned[0]?.args ?? []));
    expect(b.canView("u1")).toBe(true);
    expect(await b.take("u1")).toBeNull();
  });

  test("a browser that ignores SIGTERM is killed", async () => {
    const stubborn = fakeChild({ ignoreTerm: true });
    const b = browser({ spawn: () => stubborn });
    await b.start("u1");
    await b.stop("u1");
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a browser that closed before sign-in is reopened on the same profile", async () => {
    const b = browser();
    await b.start("u1");
    spawned[0]?.child.exit();
    expect((await b.poll("u1")).unwrap()).toMatchObject({ status: "signingIn" });
    expect(spawned).toHaveLength(2);
    expect(profileOf(spawned[1]?.args ?? [])).toBe(profileOf(spawned[0]?.args ?? []));
  });

  test("captured cookies expire if nobody pairs with them", async () => {
    const b = browser();
    await b.start("u1");
    cookieReads = [signedIn(), signedIn()];
    await b.poll("u1");
    now += 5_000;
    expect(await b.take("u1")).toBeNull();
    expect((await b.start("u2")).isOk()).toBe(true);
  });

  test("stop only affects the owner", async () => {
    const b = browser();
    await b.start("u1");
    await b.stop("u2");
    expect(b.canView("u1")).toBe(true);
    await b.stop("u1");
    expect(b.canView("u1")).toBe(false);
  });

  test("an abandoned browser closes after the idle timeout", async () => {
    const b = browser({ idleTimeoutMs: 10 });
    await b.start("u1");
    await Bun.sleep(40);
    expect(b.canView("u1")).toBe(false);
    expect(spawned[0]?.child.signals).toEqual(["SIGTERM"]);
  });
});

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { ChromiumCookies } from "./chromium-cookies";

// The fixture is a real Chromium 156 (linuxserver/chromium, --password-store=basic)
// cookie database with dummy values set over CDP: the five Gaia cookies on
// .google.com, OSID on messages.google.com and NID on .youtube.com.
const FIXTURE = join(import.meta.dir, "__fixtures__", "chromium-156-cookies.sqlite");

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "openrcs-cookies-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ChromiumCookies.readGoogle", () => {
  test("decrypts the cookies a real Chromium profile sends to messages.google.com", async () => {
    const read = (await ChromiumCookies.readGoogle(FIXTURE)).unwrap();
    expect(read).toEqual({
      status: "signedIn",
      cookies: {
        SID: "dummy-sid-value.with.dots_and-dashes",
        HSID: "AdummyHSID000001",
        SSID: "AdummySSID000002",
        APISID: "dummyAPISID/AbCdEfGhIjKlMnOp",
        SAPISID: "dummySAPISID/QrStUvWxYz012345",
        OSID: "dummy-osid-messages",
      },
    });
  });

  test("a profile with no cookie file yet is signed out", async () => {
    const dir = await scratch();
    const read = (await ChromiumCookies.readGoogle(join(dir, "Cookies"))).unwrap();
    expect(read).toEqual({ status: "signedOut", missing: ["SID", "HSID", "SSID", "APISID", "SAPISID"] });
  });

  test("names missing or expired required cookies, never values", async () => {
    const dir = await scratch();
    const path = join(dir, "Cookies");
    await copyFile(FIXTURE, path);
    const db = createClient({ url: `file:${path}` });
    await db.execute("DELETE FROM cookies WHERE name = 'SSID'");
    // 1601-based microseconds for 2001: long expired.
    await db.execute("UPDATE cookies SET expires_utc = 12643000000000000 WHERE name = 'SAPISID'");
    db.close();
    const read = (await ChromiumCookies.readGoogle(path)).unwrap();
    expect(read).toEqual({ status: "signedOut", missing: ["SSID", "SAPISID"] });
  });

  test("a value that fails the domain check is an error naming the cookie", async () => {
    const dir = await scratch();
    const path = join(dir, "Cookies");
    await copyFile(FIXTURE, path);
    const db = createClient({ url: `file:${path}` });
    // Re-home OSID's ciphertext under another host: the embedded host hash no longer matches.
    await db.execute("UPDATE cookies SET host_key = '.messages.google.com' WHERE name = 'OSID'");
    db.close();
    const read = await ChromiumCookies.readGoogle(path);
    expect(read.isErr()).toBe(true);
    if (read.isErr()) {
      expect(read.error).toMatchObject({ reason: "decrypt", cookie: "OSID" });
      expect(read.error.message).not.toContain("dummy");
    }
  });

  test("a file that is not a cookie database is unreadable", async () => {
    const dir = await scratch();
    const path = join(dir, "Cookies");
    await Bun.write(path, "not sqlite");
    const read = await ChromiumCookies.readGoogle(path);
    expect(read.isErr() && read.error.reason).toBe("unreadable");
  });
});

describe("ChromiumCookies.decryptValue", () => {
  test("returns the plain value of an unencrypted row", () => {
    const value = ChromiumCookies.decryptValue(
      { name: "SID", hostKey: ".google.com", value: "plain", encrypted: new Uint8Array(0) },
      24,
    );
    expect(value.unwrap()).toBe("plain");
  });

  test("rejects formats other than v10", () => {
    const value = ChromiumCookies.decryptValue(
      { name: "SID", hostKey: ".google.com", value: "", encrypted: new TextEncoder().encode("v11xxxxxxxxxxxxxxxx") },
      24,
    );
    expect(value.isErr() && value.error.reason).toBe("decrypt");
  });
});

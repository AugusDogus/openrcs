import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { account, user } from "@/lib/db/auth-schema";
import * as schema from "@/lib/db/schema";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { createAuth } from "./auth";
import { TailscaleIdentity } from "./auth-tailscale";
import { SessionCookie } from "./session-cookie";

const ORIGIN = "https://openrcs.tail1234.ts.net";

let t: TestDatabase;
beforeEach(async () => {
  t = await VaultTesting.createDb();
});
afterEach(async () => {
  await t.cleanup();
});

const newAuth = () =>
  createAuth({
    baseURL: ORIGIN,
    secret: randomBytes(32).toString("base64"),
    database: drizzleAdapter(t.db, { provider: "sqlite", schema }),
  });

const signIn = (auth: ReturnType<typeof createAuth>, headers: Record<string, string>) =>
  auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/tailscale`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: "{}",
    }),
  );

describe("Tailscale sign-in", () => {
  test("creates one user per tailnet login and issues a working session cookie", async () => {
    const auth = newAuth();
    const first = await signIn(auth, { "tailscale-user-login": "Augie@GitHub", "tailscale-user-name": "Augie L" });
    expect(first.status).toBe(200);
    const cookie = first.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    // Prefixed, so another Better Auth app on the same host name cannot overwrite it.
    expect(cookie).toMatch(/(^|; )(__Secure-)?openrcs\.session_token=/);
    // The proxy's optimistic redirect must recognize it, or /dashboard loops back to /sign-in.
    expect(SessionCookie.isPresent(new Headers({ cookie }))).toBe(true);

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe("augie@github");
    expect(session?.user.name).toBe("Augie L");

    const again = await signIn(auth, { "tailscale-user-login": "augie@github" });
    expect(again.status).toBe(200);
    expect(await t.db.select().from(user)).toHaveLength(1);
    const accounts = await t.db.select().from(account);
    expect(accounts.map((row) => [row.providerId, row.accountId])).toEqual([["tailscale", "augie@github"]]);

    const other = await signIn(auth, { "tailscale-user-login": "sam@example.com" });
    expect(other.status).toBe(200);
    expect(await t.db.select().from(user)).toHaveLength(2);
  });

  test("refuses requests without a usable identity and creates nothing", async () => {
    const auth = newAuth();
    for (const login of [null, "", "no-at-sign"]) {
      const response = await signIn(auth, login === null ? {} : { "tailscale-user-login": login });
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await t.db.select().from(user)).toHaveLength(0);
  });
});

describe("TailscaleIdentity.fromHeaders", () => {
  test("decodes RFC 2047 names and falls back to the login's local part", () => {
    const named = new Headers({ "tailscale-user-login": "a@b.co", "tailscale-user-name": "=?utf-8?q?Jos=C3=A9_L?=" });
    expect(TailscaleIdentity.fromHeaders(named)).toEqual({ login: "a@b.co", name: "José L" });
    expect(TailscaleIdentity.fromHeaders(new Headers({ "tailscale-user-login": "a@b.co" }))?.name).toBe("a");
  });
});

/**
 * Test support for the OAuth server: an OAuthContext around a temp database,
 * a controllable clock, and a TEST-ONLY Better Auth instance with the
 * test-utils plugin for signed-in sessions. Never imported by app code.
 */
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils } from "better-auth/plugins";
import * as schema from "@/lib/db/schema";
import { VaultTesting, type TestClock, type TestDatabase } from "@/lib/vault/testing";
import type { OAuthContext } from "./context";

export const TEST_ORIGIN = "https://openrcs.test";

const createTestAuth = (db: TestDatabase["db"], secret: string) =>
  betterAuth({
    baseURL: TEST_ORIGIN,
    secret,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    plugins: [testUtils()],
  });

export type OAuthTestHarness = {
  readonly ctx: OAuthContext;
  readonly clock: TestClock;
  readonly cleanup: () => Promise<void>;
  /** A signed-in browser for a new user, or another browser of `userId`: its Cookie header (session cookie only). */
  readonly signIn: (userId?: string) => Promise<{ readonly userId: string; readonly cookie: string }>;
};

const create = async (): Promise<OAuthTestHarness> => {
  const database = await VaultTesting.createDb();
  const clock = VaultTesting.clock();
  const secret = randomBytes(32).toString("base64");
  const auth = createTestAuth(database.db, secret);
  const ctx: OAuthContext = {
    db: database.db,
    origin: TEST_ORIGIN,
    vault: VaultTesting.vaultConfig({ now: clock.now }),
    ticketSecret: secret,
    getSession: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return session ? { userId: session.user.id, sessionId: session.session.id } : null;
    },
  };
  return {
    ctx,
    clock,
    cleanup: database.cleanup,
    signIn: async (existing) => {
      const userId = existing ?? (await VaultTesting.createUser(database.db));
      const { test } = await auth.$context;
      const login = await test.login({ userId });
      return { userId, cookie: login.headers.get("cookie") ?? "" };
    },
  };
};

/** RFC 7636 S256 pair. */
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const form = (url: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

export const OAuthTesting = { create, pkce, form, json } as const;

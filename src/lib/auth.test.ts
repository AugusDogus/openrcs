import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { account } from "@/lib/db/auth-schema";
import * as schema from "@/lib/db/schema";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { createAuth, describeAuthLogArg } from "./auth";

let t: TestDatabase;
beforeEach(async () => {
  t = await VaultTesting.createDb();
});
afterEach(async () => {
  await t.cleanup();
});

const appAuth = () =>
  createAuth({
    baseURL: "https://openrcs.test",
    secret: randomBytes(32).toString("base64"),
    github: { clientId: "test-client", clientSecret: "test-secret" },
    database: drizzleAdapter(t.db, { provider: "sqlite", schema }),
  });

const storedTokens = async (accountId: string) => {
  const [row] = await t.db
    .select({ accessToken: account.accessToken, refreshToken: account.refreshToken, idToken: account.idToken })
    .from(account)
    .where(eq(account.id, accountId));
  return row;
};

describe("GitHub account tokens", () => {
  test("are never stored: sign-up, re-sign-in updates and linking all drop them", async () => {
    const { internalAdapter } = await appAuth().$context;
    const userId = await VaultTesting.createUser(t.db);
    const created = await internalAdapter.createAccount({
      userId,
      providerId: "github",
      accountId: "12345",
      accessToken: "gho_secret-access",
      refreshToken: "ghr_secret-refresh",
      idToken: "id-token",
      scope: "read:user,user:email",
    });
    if (!created) throw new Error("expected the account to be created");
    expect(await storedTokens(created.id)).toEqual({ accessToken: null, refreshToken: null, idToken: null });

    await internalAdapter.updateAccount(created.id, { accessToken: "gho_newer", refreshToken: "ghr_newer" });
    expect(await storedTokens(created.id)).toEqual({ accessToken: null, refreshToken: null, idToken: null });

    const linked = await internalAdapter.linkAccount({
      userId,
      providerId: "github",
      accountId: "67890",
      accessToken: "gho_linked",
    });
    if (!linked) throw new Error("expected the account to be linked");
    expect(await storedTokens(linked.id)).toEqual({ accessToken: null, refreshToken: null, idToken: null });
  });
});

describe("Better Auth log arguments", () => {
  test("keep error names and causes but never a failed query's params", () => {
    const token = "SESSIONTOKENabcdefghijklmnopqrstu";
    const cause = new Error("During prerendering, fetch() rejects when the prerender is complete.");
    const failed = new Error(`Failed query: select "id" from "session" where "session"."token" = ?\nparams: ${token}`, {
      cause,
    });
    failed.name = "DrizzleQueryError";

    const logged = describeAuthLogArg(failed);

    expect(logged).not.toContain(token);
    expect(logged).toContain('DrizzleQueryError: Failed query: select "id" from "session" where "session"."token" = ?');
    expect(logged).toContain("caused by Error: During prerendering");
  });

  test("print only the type of values that are not errors", () => {
    expect(describeAuthLogArg({ token: "secret" })).toBe("<object>");
    expect(describeAuthLogArg("https://openrcs.test/callback?code=secret")).toBe("<string>");
  });
});

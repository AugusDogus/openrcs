import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { DataBox } from "@/lib/vault/data-box";
import { Dek } from "@/lib/vault/dek";
import { DeviceUnlock } from "@/lib/vault/device";
import { KeySlot } from "@/lib/vault/key-slot";
import { VaultTesting } from "@/lib/vault/testing";
import { AuthorizeEndpoint } from "./authorize";
import { OAuthClients } from "./clients";
import { ConsentFlow, type ConsentView } from "./consent";
import { GrantRevocation } from "./grant-revocation";
import { OAuthGrants } from "./grants";
import { McpAuth } from "./mcp-auth";
import { RevokeEndpoint } from "./revoke-endpoint";
import { OAuthTesting, TEST_ORIGIN, type OAuthTestHarness } from "./testing";
import { AccessToken, AuthorizationCode, RefreshToken } from "./tokens";
import { TokenEndpoint } from "./token-endpoint";

const REDIRECT = "http://127.0.0.1:8976/callback";
const RESOURCE = `${TEST_ORIGIN}/api/mcp`;

const tokenResponse = z.object({
  access_token: z.string().startsWith("oat_"),
  token_type: z.literal("Bearer"),
  expires_in: z.literal(3600),
  refresh_token: z.string().startsWith("ort_"),
  scope: z.string(),
});
const errorResponse = z.object({ error: z.string(), error_description: z.string() });

let h: OAuthTestHarness;
beforeEach(async () => {
  h = await OAuthTesting.create();
});
afterEach(async () => {
  await h.cleanup();
});

type Browser = { userId: string; cookie: string };

const registerClient = async (body: Record<string, unknown> = {}) => {
  const response = await OAuthClients.register(
    h.ctx,
    OAuthTesting.json(`${TEST_ORIGIN}/oauth/register`, { redirect_uris: [REDIRECT], client_name: "Test MCP", ...body }),
  );
  expect(response.status).toBe(201);
  return z
    .object({ client_id: z.string(), client_secret: z.string().optional() })
    .parse(await response.json());
};

const authorizeParams = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: RESOURCE,
    ...extra,
  });

const authorize = (params: URLSearchParams, cookie?: string) =>
  AuthorizeEndpoint.handle(
    h.ctx,
    new Request(`${TEST_ORIGIN}/oauth/authorize?${params.toString()}`, {
      headers: cookie ? { cookie } : {},
    }),
  );

const consentView = async (params: URLSearchParams, cookie: string): Promise<ConsentView> => {
  const response = await authorize(params, cookie);
  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("/oauth/consent?")).toBe(true);
  return ConsentFlow.load(h.ctx, new URL(location, TEST_ORIGIN).searchParams, new Headers({ cookie }));
};

const readyTicket = (view: ConsentView): string => {
  if (view.kind !== "ready") throw new Error(`expected a ready consent view, got ${view.kind}`);
  return view.ticket;
};

const decide = (ticket: string, decision: "approve" | "deny", cookie: string, origin = TEST_ORIGIN) =>
  ConsentFlow.decide(
    h.ctx,
    OAuthTesting.form(`${TEST_ORIGIN}/oauth/consent/decision`, { ticket, decision }, { origin, cookie }),
  );

/** Runs authorize -> consent -> approve for `browser` and returns the code plus the browser's new cookies. */
const approve = async (browser: Browser, clientId: string, challenge: string, extra: Record<string, string> = {}) => {
  const ticket = readyTicket(await consentView(authorizeParams(clientId, challenge, extra), browser.cookie));
  const response = await decide(ticket, "approve", browser.cookie);
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("state-123");
  expect(location.searchParams.get("iss")).toBe(TEST_ORIGIN);
  const setCookie = response.headers.get("set-cookie");
  browser.cookie = OAuthTesting.mergeCookies(browser.cookie, setCookie ? VaultTesting.cookiePair(setCookie) : null);
  return { code: location.searchParams.get("code") ?? "", setCookie };
};

const token = (params: Record<string, string>, headers: Record<string, string> = {}) =>
  TokenEndpoint.handle(h.ctx, OAuthTesting.form(`${TEST_ORIGIN}/oauth/token`, params, headers));

const exchange = (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
  token({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    resource: RESOURCE,
    ...extra,
  });

const refresh = (clientId: string, refreshToken: string, extra: Record<string, string> = {}) =>
  token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, ...extra });

const mcpRequest = (accessToken: string | null) =>
  new Request(`${TEST_ORIGIN}/api/mcp`, {
    method: "POST",
    headers: accessToken === null ? {} : { authorization: `Bearer ${accessToken}` },
  });

const expectOAuthError = async (response: Response, status: number, error: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(errorResponse.parse(await response.json()).error).toBe(error);
};

/** Registers a client, signs in, approves and redeems: the happy path. */
const connected = async () => {
  const client = await registerClient();
  const browser = await h.signIn();
  const { verifier, challenge } = OAuthTesting.pkce();
  const { code, setCookie } = await approve(browser, client.client_id, challenge);
  const response = await exchange(client.client_id, code, verifier);
  expect(response.status).toBe(200);
  const tokens = tokenResponse.parse(await response.json());
  return { client, browser, code, verifier, tokens, setCookie };
};

const grantOf = async (userId: string) => {
  const [grant] = await h.ctx.db.select().from(oauthGrant).where(eq(oauthGrant.userId, userId));
  if (!grant) throw new Error("expected a grant");
  return grant;
};

describe("authorization code flow", () => {
  test("register -> authorize -> consent -> token -> authenticated MCP request with the user's DEK", async () => {
    const { client, browser, tokens, setCookie } = await connected();
    expect(tokens.scope).toBe("messages:read messages:send");
    // First consent before pairing minted the vault key and set the device cookie.
    expect(setCookie).toMatch(/^__Host-openrcs-device-[A-Za-z0-9_-]{16}=.*; HttpOnly; SameSite=Lax; Secure$/);

    const auth = (await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token))).unwrap();
    expect(auth.userId).toBe(browser.userId);
    expect(auth.clientId).toBe(client.client_id);
    expect(auth.scopes).toEqual(["messages:read", "messages:send"]);
    const grant = await grantOf(browser.userId);
    expect(auth.grantId).toBe(grant.id);
    expect(auth.dek.id).toBe(grant.dekId);

    // The MCP DEK is the same key the browser's device slot unlocks.
    const browserDek = (await DeviceUnlock.unlockWith(h.ctx.db, h.ctx.vault, browser.userId, browser.cookie)).unwrap();
    const aad = { userId: browser.userId, table: "gm_session", rowKey: browser.userId, column: "auth_data" };
    expect(DataBox.open(auth.dek, DataBox.seal(browserDek, "shared", aad), aad).unwrap()).toBe("shared");
  });

  test("a second consent from the paired browser reuses its key and sets no cookie", async () => {
    const { browser, tokens } = await connected();
    const first = (await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token))).unwrap();
    const other = await registerClient();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code, setCookie } = await approve(browser, other.client_id, challenge);
    expect(setCookie).toBeNull();
    const second = tokenResponse.parse(await (await exchange(other.client_id, code, verifier)).json());
    const auth = (await McpAuth.authenticate(h.ctx, mcpRequest(second.access_token))).unwrap();
    expect(auth.dek.id).toBe(first.dek.id);
  });

  test("requested scope is intersected with the client's registration", async () => {
    const client = await registerClient({ scope: "messages:read" });
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge, { scope: "messages:read messages:send" });
    const tokens = tokenResponse.parse(await (await exchange(client.client_id, code, verifier)).json());
    expect(tokens.scope).toBe("messages:read");
  });

  test("deny redirects with access_denied and state, and creates nothing", async () => {
    const client = await registerClient();
    const browser = await h.signIn();
    const ticket = readyTicket(await consentView(authorizeParams(client.client_id, OAuthTesting.pkce().challenge), browser.cookie));
    const response = await decide(ticket, "deny", browser.cookie);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(await h.ctx.db.select().from(oauthGrant)).toHaveLength(0);
  });
});

describe("/oauth/authorize validation", () => {
  test("unknown client or unregistered redirect_uri: error page, never a redirect", async () => {
    const client = await registerClient();
    const { challenge } = OAuthTesting.pkce();
    for (const params of [
      authorizeParams("no-such-client", challenge),
      authorizeParams(client.client_id, challenge, { redirect_uri: "http://127.0.0.1:8976/other" }),
      authorizeParams(client.client_id, challenge, { redirect_uri: `${REDIRECT}/` }),
    ]) {
      const response = await authorize(params);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  test("other errors render an error page and never redirect to the (dynamically registered) redirect URI", async () => {
    const client = await registerClient({ redirect_uris: ["https://evil.example/phish"] });
    const browser = await h.signIn();
    const { challenge } = OAuthTesting.pkce();
    const cases: readonly Record<string, string>[] = [
      { response_type: "" },
      { code_challenge_method: "plain" },
      { code_challenge: "" },
      { code_challenge: "short" },
      { response_type: "token" },
      { resource: "https://elsewhere.example/api/mcp" },
      { scope: "openid" },
    ];
    for (const extra of cases) {
      const params = authorizeParams(client.client_id, challenge, { redirect_uri: "https://evil.example/phish", ...extra });
      for (const cookie of [undefined, browser.cookie]) {
        const response = await authorize(params, cookie);
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("content-type")).toContain("text/html");
      }
    }
  });

  test("not signed in: relative redirect to GitHub sign-in that resumes this request", async () => {
    const client = await registerClient();
    const params = authorizeParams(client.client_id, OAuthTesting.pkce().challenge);
    const response = await authorize(params);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/sign-in?")).toBe(true);
    const callbackURL = new URL(location, TEST_ORIGIN).searchParams.get("callbackURL");
    expect(callbackURL).toBe(`/oauth/authorize?${params.toString()}`);
  });

  test("the consent view carries the raw client name (React escapes it) and the redirect host", async () => {
    const client = await registerClient({ client_name: "<script>alert(1)</script>" });
    const browser = await h.signIn();
    const view = await consentView(authorizeParams(client.client_id, OAuthTesting.pkce().challenge), browser.cookie);
    expect(view.kind === "ready" && view.clientName).toBe("<script>alert(1)</script>");
    expect(view.kind === "ready" && view.redirectHost).toBe("127.0.0.1:8976");
  });
});

describe("consent CSRF protection", () => {
  const prepare = async () => {
    const client = await registerClient();
    const browser = await h.signIn();
    const ticket = readyTicket(await consentView(authorizeParams(client.client_id, OAuthTesting.pkce().challenge), browser.cookie));
    return { client, browser, ticket };
  };

  test("requires our Origin", async () => {
    const { browser, ticket } = await prepare();
    expect((await decide(ticket, "approve", browser.cookie, "https://evil.example")).status).toBe(403);
    const noOrigin = await ConsentFlow.decide(
      h.ctx,
      OAuthTesting.form(`${TEST_ORIGIN}/oauth/consent/decision`, { ticket, decision: "approve" }, { cookie: browser.cookie }),
    );
    expect(noOrigin.status).toBe(403);
    expect(await h.ctx.db.select().from(oauthGrant)).toHaveLength(0);
  });

  test("tickets are single use", async () => {
    const { browser, ticket } = await prepare();
    expect((await decide(ticket, "approve", browser.cookie)).status).toBe(303);
    const replay = await decide(ticket, "approve", browser.cookie);
    expect(replay.status).toBe(400);
    expect(await h.ctx.db.select().from(oauthGrant)).toHaveLength(1);
  });

  test("tickets are bound to the session and expire", async () => {
    const { ticket } = await prepare();
    const otherBrowser = await h.signIn();
    expect((await decide(ticket, "approve", otherBrowser.cookie)).status).toBe(400);

    const second = await prepare();
    h.clock.advance(10 * 60 * 1000);
    expect((await decide(second.ticket, "approve", second.browser.cookie)).status).toBe(400);

    const third = await prepare();
    const forged = `${third.ticket.split(".")[0]}.${"A".repeat(43)}`;
    expect((await decide(forged, "approve", third.browser.cookie)).status).toBe(400);
    expect(await h.ctx.db.select().from(oauthGrant)).toHaveLength(0);
  });

  test("signed-out submissions are refused", async () => {
    const { ticket } = await prepare();
    expect((await decide(ticket, "approve", "")).status).toBe(401);
  });
});

describe("consent lock rule", () => {
  test("after pairing, a browser that cannot unlock the account sees the locked page and cannot approve", async () => {
    const { browser, client } = await connected();
    const grant = await grantOf(browser.userId);
    // Pair the phone under the DEK this browser holds.
    await VaultTesting.pairSession(h.ctx.db, browser.userId, { id: grant.dekId, bytes: new Uint8Array(32) });

    const sessionOnly = {
      userId: browser.userId,
      cookie: browser.cookie
        .split("; ")
        .filter((cookie) => !cookie.startsWith("__Host-openrcs-device"))
        .join("; "),
    };
    const params = authorizeParams(client.client_id, OAuthTesting.pkce().challenge);
    const view = await consentView(params, sessionOnly.cookie);
    expect(view.kind).toBe("locked");

    // A ticket obtained by the paired browser cannot be redeemed without its device cookie either.
    const ticket = readyTicket(await consentView(params, browser.cookie));
    const response = await decide(ticket, "approve", sessionOnly.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")?.startsWith("/oauth/consent?")).toBe(true);
    const grants = await h.ctx.db.select().from(oauthGrant).where(eq(oauthGrant.userId, browser.userId));
    expect(grants).toHaveLength(1);
  });
});

describe("token endpoint: authorization_code", () => {
  test("PKCE failures, wrong redirect_uri, wrong resource and wrong client are invalid_grant/invalid_target", async () => {
    const client = await registerClient();
    const other = await registerClient();
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);

    await expectOAuthError(await exchange(client.client_id, code, OAuthTesting.pkce().verifier), 400, "invalid_grant");
    await expectOAuthError(await exchange(client.client_id, code, "too-short"), 400, "invalid_grant");
    await expectOAuthError(await exchange(client.client_id, code, verifier, { redirect_uri: "http://127.0.0.1:8976/other" }), 400, "invalid_grant");
    await expectOAuthError(await exchange(client.client_id, code, verifier, { resource: "https://elsewhere.example/api/mcp" }), 400, "invalid_target");
    await expectOAuthError(await exchange(other.client_id, code, verifier), 400, "invalid_grant");
    await expectOAuthError(await exchange(client.client_id, code, verifier, { code_verifier: "" }), 400, "invalid_request");

    // None of the failed attempts consumed the code.
    expect((await exchange(client.client_id, code, verifier)).status).toBe(200);
  });

  test("codes expire after 60 seconds", async () => {
    const client = await registerClient();
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);
    h.clock.advance(60_000);
    await expectOAuthError(await exchange(client.client_id, code, verifier), 400, "invalid_grant");
  });

  test("a second use of a code revokes the grant and its refresh tokens", async () => {
    const { client, code, verifier, tokens, browser } = await connected();
    await expectOAuthError(await exchange(client.client_id, code, verifier), 400, "invalid_grant");
    const grant = await grantOf(browser.userId);
    expect(grant.revokedReason).toBe("authorization_code_reuse");
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token), 400, "invalid_grant");
    const auth = await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token));
    expect(auth.isErr()).toBe(true);
  });

  test("a used code replayed by another client, or long after use, is invalid_grant without revoking", async () => {
    const { client, code, tokens, browser } = await connected();
    const attacker = await registerClient();
    const junk = "x".repeat(43);
    await expectOAuthError(await exchange(attacker.client_id, code, junk), 400, "invalid_grant");
    expect((await grantOf(browser.userId)).revokedAt).toBeNull();

    h.clock.advance(3 * 24 * 60 * 60 * 1000);
    await expectOAuthError(await exchange(client.client_id, code, junk), 400, "invalid_grant");
    expect((await grantOf(browser.userId)).revokedAt).toBeNull();
    expect((await refresh(client.client_id, tokens.refresh_token)).status).toBe(200);
  });

  test("tampered codes are invalid_grant", async () => {
    const client = await registerClient();
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);
    const tampered = `${code.slice(0, -2)}${code.endsWith("AA") ? "AB" : "AA"}`;
    await expectOAuthError(await exchange(client.client_id, tampered, verifier), 400, "invalid_grant");
    await expectOAuthError(await exchange(client.client_id, "oac_garbage", verifier), 400, "invalid_grant");
  });

  test("confidential clients must authenticate with their registered method", async () => {
    const client = await registerClient({ token_endpoint_auth_method: "client_secret_basic" });
    const secret = client.client_secret ?? "";
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);
    const params = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier };
    const basic = (id: string, pw: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(pw)}`).toString("base64")}`;

    const wrong = await token(params, { authorization: basic(client.client_id, "ocs_wrong") });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Basic");
    await expectOAuthError(await token({ ...params, client_id: client.client_id }), 401, "invalid_client");
    await expectOAuthError(await token({ ...params, client_id: client.client_id, client_secret: secret }), 401, "invalid_client");
    expect((await token(params, { authorization: basic(client.client_id, secret) })).status).toBe(200);
  });

  test("unsupported grant types and non-form bodies are rejected", async () => {
    const client = await registerClient();
    await expectOAuthError(await token({ grant_type: "password", client_id: client.client_id }), 400, "unsupported_grant_type");
    const jsonBody = await TokenEndpoint.handle(h.ctx, OAuthTesting.json(`${TEST_ORIGIN}/oauth/token`, { grant_type: "refresh_token" }));
    await expectOAuthError(jsonBody, 400, "invalid_request");
    await expectOAuthError(await token({ grant_type: "refresh_token", client_id: client.client_id, scope: "a", refresh_token: "x" }, {}), 400, "invalid_grant");
  });
});

describe("token endpoint throttling", () => {
  test("junk requests naming a public client_id from one address do not throttle that client elsewhere", async () => {
    const { client, tokens } = await connected();
    for (let i = 0; i < 70; i += 1) {
      await token({ grant_type: "junk", client_id: client.client_id }, { "x-forwarded-for": "192.0.2.66" });
    }
    const legit = await refresh(client.client_id, tokens.refresh_token);
    expect(legit.status).toBe(200);
    const flooded = await token({ grant_type: "junk", client_id: client.client_id }, { "x-forwarded-for": "192.0.2.66" });
    expect(flooded.status).toBe(429);
  });
});

describe("token endpoint: refresh_token", () => {
  test("rotation: the new token works, the old one is consumed", async () => {
    const { client, tokens } = await connected();
    const rotated = tokenResponse.parse(await (await refresh(client.client_id, tokens.refresh_token)).json());
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(rotated.access_token))).isOk()).toBe(true);
    expect((await refresh(client.client_id, rotated.refresh_token)).status).toBe(200);
  });

  test("replay of a rotated token inside the 30 s grace is invalid_grant without revoking", async () => {
    const { client, tokens, browser } = await connected();
    const rotated = tokenResponse.parse(await (await refresh(client.client_id, tokens.refresh_token)).json());
    h.clock.advance(30_000);
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token), 400, "invalid_grant");
    expect((await grantOf(browser.userId)).revokedAt).toBeNull();
    expect((await refresh(client.client_id, rotated.refresh_token)).status).toBe(200);
  });

  test("replay after the grace revokes the grant and all its slots", async () => {
    const { client, tokens, browser } = await connected();
    const rotated = tokenResponse.parse(await (await refresh(client.client_id, tokens.refresh_token)).json());
    h.clock.advance(30_001);
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token), 400, "invalid_grant");
    const grant = await grantOf(browser.userId);
    expect(grant.revokedReason).toBe("refresh_token_reuse");
    const live = await h.ctx.db
      .select()
      .from(keySlot)
      .where(and(eq(keySlot.grantId, grant.id)));
    expect(live.every((slot) => slot.revokedAt !== null)).toBe(true);
    await expectOAuthError(await refresh(client.client_id, rotated.refresh_token), 400, "invalid_grant");
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(rotated.access_token))).isErr()).toBe(true);
  });

  test("scope may only narrow", async () => {
    const { client, tokens } = await connected();
    const narrowed = tokenResponse.parse(
      await (await refresh(client.client_id, tokens.refresh_token, { scope: "messages:read" })).json(),
    );
    expect(narrowed.scope).toBe("messages:read");
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(narrowed.access_token))).unwrap().scopes).toEqual(["messages:read"]);
    // The refresh token keeps the original grant, so the next refresh can return to the full set.
    const full = tokenResponse.parse(await (await refresh(client.client_id, narrowed.refresh_token)).json());
    expect(full.scope).toBe("messages:read messages:send");
    await expectOAuthError(await refresh(client.client_id, full.refresh_token, { scope: "messages:read admin" }), 400, "invalid_scope");
  });

  test("narrowing below the registration is enforced too", async () => {
    const client = await registerClient({ scope: "messages:read" });
    const browser = await h.signIn();
    const { verifier, challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);
    const tokens = tokenResponse.parse(await (await exchange(client.client_id, code, verifier)).json());
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token, { scope: "messages:send" }), 400, "invalid_scope");
  });

  test("another client cannot use the refresh token", async () => {
    const { tokens } = await connected();
    const other = await registerClient();
    await expectOAuthError(await refresh(other.client_id, tokens.refresh_token), 400, "invalid_grant");
  });

  test("refresh tokens expire after 90 days without use", async () => {
    const { client, tokens } = await connected();
    h.clock.advance(90 * 24 * 60 * 60 * 1000);
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token), 400, "invalid_grant");
  });
});

describe("key share destruction", () => {
  test("after use, rotation and revocation, no old credential can unwrap the DEK", async () => {
    const { client, code, tokens, browser } = await connected();
    const rotated = tokenResponse.parse(await (await refresh(client.client_id, tokens.refresh_token)).json());
    const grant = await grantOf(browser.userId);
    expect((await OAuthGrants.revokeOwned(h.ctx.db, browser.userId, grant.id, h.clock.now())).unwrap()).toBe(true);

    const credentials = [
      AuthorizationCode.parse(code),
      RefreshToken.parse(tokens.refresh_token),
      RefreshToken.parse(rotated.refresh_token),
    ];
    for (const credential of credentials) {
      if (!credential) throw new Error("expected a parsable credential");
      const [row] = await h.ctx.db.select().from(keySlot).where(eq(keySlot.id, credential.slotId));
      if (!row) throw new Error("expected the slot row to remain for replay detection");
      expect(KeySlot.verify(h.ctx.vault, row, credential).isOk()).toBe(true);
      expect(KeySlot.unwrap(h.ctx.vault, row, credential).isErr()).toBe(true);
    }
  });

  test("an unredeemed, expired code loses its key share on the user's next token write", async () => {
    const { client, tokens, browser } = await connected();
    const { challenge } = OAuthTesting.pkce();
    const { code } = await approve(browser, client.client_id, challenge);
    h.clock.advance(60_000);
    expect((await refresh(client.client_id, tokens.refresh_token)).status).toBe(200);
    const credential = AuthorizationCode.parse(code);
    if (!credential) throw new Error("expected a parsable code");
    const [row] = await h.ctx.db.select().from(keySlot).where(eq(keySlot.id, credential.slotId));
    if (!row) throw new Error("expected the code slot row");
    expect(KeySlot.unwrap(h.ctx.vault, row, credential).isErr()).toBe(true);
  });
});

describe("access tokens and /api/mcp authentication", () => {
  test("missing token: 401 with resource_metadata and no error", async () => {
    const result = await McpAuth.authenticate(h.ctx, mcpRequest(null));
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "McpUnauthorizedError") {
      const response = McpAuth.unauthorizedResponse(h.ctx, result.error);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
      );
    } else {
      throw new Error("expected McpUnauthorizedError");
    }
  });

  const expectInvalidToken = async (accessToken: string) => {
    const result = await McpAuth.authenticate(h.ctx, mcpRequest(accessToken));
    if (result.isErr() && result.error._tag === "McpUnauthorizedError") {
      const header = McpAuth.unauthorizedResponse(h.ctx, result.error).headers.get("www-authenticate") ?? "";
      expect(header).toStartWith('Bearer error="invalid_token"');
      expect(header).toContain(`resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
      return result.error.reason;
    }
    throw new Error("expected McpUnauthorizedError");
  };

  test("tampered, foreign-key and garbage tokens are invalid_token", async () => {
    const { tokens } = await connected();
    const body = tokens.access_token;
    const flipped = `${body.slice(0, -3)}${body.at(-3) === "A" ? "B" : "A"}${body.slice(-2)}`;
    expect(await expectInvalidToken(flipped)).toBe("unauthentic");
    expect(await expectInvalidToken("oat_v1.x.y")).toBe("malformed");
    expect(await expectInvalidToken("not-a-token")).toBe("malformed");
    const foreign = AccessToken.seal(VaultTesting.vaultConfig().pepper, {
      userId: "u",
      grantId: "g",
      clientId: "c",
      scopes: ["messages:read"],
      exp: Math.floor(h.clock.now() / 1000) + 3600,
      dek: Dek.generate(),
    });
    expect(await expectInvalidToken(foreign)).toBe("unauthentic");
  });

  test("access tokens expire after one hour", async () => {
    const { tokens } = await connected();
    h.clock.advance(3599_000);
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token))).isOk()).toBe(true);
    h.clock.advance(1_000);
    expect(await expectInvalidToken(tokens.access_token)).toBe("expired");
  });

  test("a revoked grant is rejected even with an unexpired token", async () => {
    const { tokens, browser } = await connected();
    const grant = await grantOf(browser.userId);
    await h.ctx.db.update(oauthGrant).set({ revokedAt: h.clock.now() }).where(eq(oauthGrant.id, grant.id));
    expect(await expectInvalidToken(tokens.access_token)).toBe("revoked");
  });

  test("re-pairing under a new DEK makes old tokens stale", async () => {
    const { tokens, browser } = await connected();
    await VaultTesting.pairSession(h.ctx.db, browser.userId, Dek.generate());
    expect(await expectInvalidToken(tokens.access_token)).toBe("stale_key");
  });

  test("last_used_at is updated at most once a minute", async () => {
    const { tokens, browser } = await connected();
    const lastUsed = async () => (await grantOf(browser.userId)).lastUsedAt;
    await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token));
    const first = await lastUsed();
    expect(first).toBe(h.clock.now());
    h.clock.advance(59_000);
    await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token));
    expect(await lastUsed()).toBe(first);
    h.clock.advance(1_000);
    await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token));
    expect(await lastUsed()).toBe(h.clock.now());
  });

  test("insufficient_scope response names the missing scope", async () => {
    const response = McpAuth.insufficientScope(h.ctx, ["messages:send"]);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="messages:send"');
  });
});

describe("POST /oauth/revoke", () => {
  const revoke = (params: Record<string, string>) =>
    RevokeEndpoint.handle(h.ctx, OAuthTesting.form(`${TEST_ORIGIN}/oauth/revoke`, params));

  test("revoking a refresh token kills the grant, its refresh tokens and access tokens", async () => {
    const { client, tokens, browser } = await connected();
    const response = await revoke({ token: tokens.refresh_token, client_id: client.client_id });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect((await grantOf(browser.userId)).revokedReason).toBe("revoked_by_client");
    await expectOAuthError(await refresh(client.client_id, tokens.refresh_token), 400, "invalid_grant");
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token))).isErr()).toBe(true);
  });

  test("revoking an access token revokes its grant", async () => {
    const { tokens, browser } = await connected();
    expect((await revoke({ token: tokens.access_token })).status).toBe(200);
    expect((await grantOf(browser.userId)).revokedAt).not.toBeNull();
  });

  test("unknown tokens and other clients' tokens get 200 and change nothing", async () => {
    const { tokens, browser } = await connected();
    const other = await registerClient();
    expect((await revoke({ token: "ort_nope.nope" })).status).toBe(200);
    expect((await revoke({ token: tokens.refresh_token, client_id: other.client_id })).status).toBe(200);
    expect((await grantOf(browser.userId)).revokedAt).toBeNull();
    await expectOAuthError(await revoke({}), 400, "invalid_request");
  });
});

describe("dashboard grant revocation", () => {
  const revokeFromDashboard = (grantId: string, cookie: string, origin = TEST_ORIGIN) =>
    GrantRevocation.handle(
      h.ctx,
      new Request(`${TEST_ORIGIN}/api/oauth/grants/${grantId}/revoke`, { method: "POST", headers: { origin, cookie } }),
      grantId,
    );

  test("only the owner, same-origin, can revoke", async () => {
    const { browser, tokens } = await connected();
    const grant = await grantOf(browser.userId);
    const stranger = await h.signIn();
    expect((await revokeFromDashboard(grant.id, browser.cookie, "https://evil.example")).status).toBe(403);
    expect((await revokeFromDashboard(grant.id, stranger.cookie)).status).toBe(404);
    expect((await revokeFromDashboard(grant.id, "")).status).toBe(401);
    expect((await grantOf(browser.userId)).revokedAt).toBeNull();

    const response = await revokeFromDashboard(grant.id, browser.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect((await grantOf(browser.userId)).revokedReason).toBe("revoked_by_user");
    expect((await McpAuth.authenticate(h.ctx, mcpRequest(tokens.access_token))).isErr()).toBe(true);
  });
});

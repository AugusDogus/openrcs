import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { oauthClient, oauthGrant, requestThrottle } from "@/lib/db/vault-schema";
import { VaultTesting } from "@/lib/vault/testing";
import { OAuthClients } from "./clients";
import { OAuthHttp } from "./http";
import { RedirectUri } from "./redirect-uri";
import { OAuthTesting, TEST_ORIGIN, type OAuthTestHarness } from "./testing";
import { RequestThrottle } from "./throttle";

describe("RedirectUri.validate", () => {
  const accepted = [
    "https://client.example/callback",
    "https://client.example:8443/cb?x=1",
    "http://127.0.0.1:33418/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]:8080/cb",
    "cursor://anysphere.cursor-retrieval/oauth/user-openrcs/callback",
    "com.example.app:/oauth2redirect",
  ];
  const rejected: readonly [unknown, string][] = [
    ["http://client.example/callback", "http is only allowed for loopback"],
    ["http://127.0.0.2.example/cb", "http is only allowed for loopback"],
    ["javascript:alert(1)", "javascript: scheme"],
    ["JavaScript:alert(1)", "javascript: scheme"],
    ["data:text/html,<script>alert(1)</script>", "data: scheme"],
    ["data:text/html,hi", "data: scheme"],
    ["file:///etc/passwd", "file: scheme"],
    ["vbscript:msgbox", "vbscript: scheme"],
    ["https://client.example/cb#frag", "fragment"],
    ["https://client.example/cb#", "fragment"],
    ["https://user:pass@client.example/cb", "user information"],
    ["https://@client.example/cb", "user information"],
    ["/relative/callback", "absolute"],
    ["https://client.example/a b", "whitespace"],
    ["myapp:", "need a path"],
    [`https://client.example/${"a".repeat(512)}`, "at most 512"],
    ["", "non-empty"],
    [42, "non-empty"],
  ];

  test.each(accepted)("accepts %s", (uri) => {
    expect(RedirectUri.validate(uri).unwrap()).toBe(uri);
  });

  test.each(rejected)("rejects %p", (uri, reason) => {
    const result = RedirectUri.validate(uri);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.reason).toContain(reason);
  });
});

describe("OAuthHttp.throttleBucket", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:0DB8:0000:0000:ffff:0:0:1", "2001:db8:0:0::/64"],
    ["[2001:db8:1:2:3::4]", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::ffff:198.51.100.4", "198.51.100.4"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
    ["2001:db8::1::2", "2001:db8::1::2"],
    ["not:an:address", "not:an:address"],
  ])("%s -> %s", (address, bucket) => {
    expect(OAuthHttp.throttleBucket(address)).toBe(bucket);
  });
});

describe("OAuthClients.parseRegistration", () => {
  const base = { redirect_uris: ["https://client.example/cb"] };

  test("defaults: public client, both scopes, generic name", () => {
    expect(OAuthClients.parseRegistration(base).unwrap()).toEqual({
      redirectUris: ["https://client.example/cb"],
      clientName: "MCP client",
      tokenEndpointAuthMethod: "none",
      scopes: ["messages:read", "messages:send"],
      clientUri: null,
      logoUri: null,
    });
  });

  test("keeps the client name as given (escaping happens on render)", () => {
    const name = `<img src=x onerror="alert(1)"> & Co`;
    expect(OAuthClients.parseRegistration({ ...base, client_name: name }).unwrap().clientName).toBe(name);
  });

  test("scope: narrows to supported scopes, ignores unknown ones", () => {
    const parsed = (scope: string) => OAuthClients.parseRegistration({ ...base, scope }).unwrap().scopes;
    expect(parsed("messages:read")).toEqual(["messages:read"]);
    expect(parsed("openid messages:send profile")).toEqual(["messages:send"]);
    expect(parsed("openid profile")).toEqual(["messages:read", "messages:send"]);
  });

  const invalid: readonly [string, Record<string, unknown>, string][] = [
    ["missing redirect_uris", {}, "invalid_redirect_uri"],
    ["empty redirect_uris", { redirect_uris: [] }, "invalid_redirect_uri"],
    ["too many redirect_uris", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`) }, "invalid_redirect_uri"],
    ["non-string redirect uri", { redirect_uris: [1] }, "invalid_redirect_uri"],
    ["bad redirect uri", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    ["long client_name", { ...base, client_name: "x".repeat(201) }, "invalid_client_metadata"],
    ["non-string client_name", { ...base, client_name: 5 }, "invalid_client_metadata"],
    ["unknown auth method", { ...base, token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    ["implicit grant", { ...base, grant_types: ["implicit"] }, "invalid_client_metadata"],
    ["refresh without code grant", { ...base, grant_types: ["refresh_token"] }, "invalid_client_metadata"],
    ["token response type", { ...base, response_types: ["token"] }, "invalid_client_metadata"],
    ["http logo", { ...base, logo_uri: "http://cdn.example/logo.png" }, "invalid_client_metadata"],
    ["non-string scope", { ...base, scope: ["messages:read"] }, "invalid_client_metadata"],
  ];

  test.each(invalid)("rejects %s", (_name, body, error) => {
    const result = OAuthClients.parseRegistration(body);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.error).toBe(error);
      expect(result.error.status).toBe(400);
    }
  });
});

const registrationResponse = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  scope: z.string(),
  client_secret: z.string().optional(),
  client_secret_expires_at: z.number().optional(),
});

describe("POST /oauth/register", () => {
  let h: OAuthTestHarness;
  beforeEach(async () => {
    h = await OAuthTesting.create();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const register = (body: unknown, headers: Record<string, string> = {}) =>
    OAuthClients.register(h.ctx, OAuthTesting.json(`${TEST_ORIGIN}/oauth/register`, body, headers));

  test("public client: 201 with RFC 7591 fields, no secret, CORS, no-store", async () => {
    const response = await register({ redirect_uris: ["http://127.0.0.1:9/cb"], client_name: "Claude" });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = registrationResponse.parse(await response.json());
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: ["http://127.0.0.1:9/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "messages:read messages:send",
    });
    expect(body.client_secret).toBeUndefined();
  });

  test("confidential client: secret returned once, only its SHA-256 stored", async () => {
    const response = await register({
      redirect_uris: ["https://client.example/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    const body = registrationResponse.parse(await response.json());
    expect(body.client_secret).toMatch(/^ocs_/);
    expect(body.client_secret_expires_at).toBe(0);
    const [row] = await h.ctx.db.select().from(oauthClient).where(eq(oauthClient.clientId, body.client_id));
    expect(row?.clientSecretHash).toBe(OAuthClients.hashSecret(body.client_secret ?? ""));
    expect(JSON.stringify(row)).not.toContain(body.client_secret ?? "unreachable");
  });

  test("invalid metadata and non-JSON bodies get 400 errors", async () => {
    const bad = await register({ redirect_uris: ["javascript:alert(1)"] });
    expect(bad.status).toBe(400);
    expect(z.object({ error: z.string() }).parse(await bad.json()).error).toBe("invalid_redirect_uri");
    const notJson = await OAuthClients.register(
      h.ctx,
      new Request(`${TEST_ORIGIN}/oauth/register`, { method: "POST", body: "redirect_uris=x" }),
    );
    expect(notJson.status).toBe(400);
  });

  test("throttles IPv6 clients per /64, not per address", async () => {
    const from = (ip: string) => register({ redirect_uris: ["https://c.example/cb"] }, { "x-forwarded-for": ip });
    for (let i = 0; i < 30; i += 1) expect((await from(`2001:db8::${i.toString(16)}`)).status).toBe(201);
    expect((await from("2001:0db8:0000:0000:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await from("2001:db8:0:1::1")).status).toBe(201);
  });

  test("caps registrations across all addresses", async () => {
    const { limit } = RequestThrottle.rules.registerGlobal;
    for (let i = 0; i < limit; i += 1) {
      const response = await register({ redirect_uris: ["https://c.example/cb"] }, { "x-forwarded-for": `198.18.${i >> 8}.${i & 255}` });
      expect(response.status).toBe(201);
    }
    const capped = await register({ redirect_uris: ["https://c.example/cb"] }, { "x-forwarded-for": "203.0.113.200" });
    expect(capped.status).toBe(429);
    h.clock.advance(RequestThrottle.rules.registerGlobal.windowMs);
    expect((await register({ redirect_uris: ["https://c.example/cb"] }, { "x-forwarded-for": "203.0.113.200" })).status).toBe(201);
  });

  test("registering prunes day-old clients that have no grant, and expired throttle windows", async () => {
    const old = h.clock.now() - 25 * 60 * 60 * 1000;
    const client = (clientId: string, createdAt: number) => ({
      clientId,
      clientName: "Old",
      redirectUrisJson: "[]",
      tokenEndpointAuthMethod: "none" as const,
      scope: "messages:read",
      createdAt,
    });
    await h.ctx.db.insert(oauthClient).values([client("unused-old", old), client("used-old", old), client("unused-new", h.clock.now())]);
    const userId = await VaultTesting.createUser(h.ctx.db);
    await h.ctx.db.insert(oauthGrant).values({ id: "g1", userId, clientId: "used-old", scope: "messages:read" });
    await h.ctx.db.insert(requestThrottle).values([
      { key: "token:ip:192.0.2.1", windowStart: old, count: 3 },
      { key: "token:ip:192.0.2.2", windowStart: h.clock.now(), count: 3 },
    ]);

    expect((await register({ redirect_uris: ["https://c.example/cb"] })).status).toBe(201);
    const ids = (await h.ctx.db.select({ id: oauthClient.clientId }).from(oauthClient)).map((row) => row.id);
    expect(ids).not.toContain("unused-old");
    expect(ids).toEqual(expect.arrayContaining(["used-old", "unused-new"]));
    const keys = (await h.ctx.db.select({ key: requestThrottle.key }).from(requestThrottle)).map((row) => row.key);
    expect(keys).not.toContain("token:ip:192.0.2.1");
    expect(keys).toContain("token:ip:192.0.2.2");
  });

  test("throttled per IP", async () => {
    const headers = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 30; i += 1) {
      expect((await register({ redirect_uris: ["https://c.example/cb"] }, headers)).status).toBe(201);
    }
    const limited = await register({ redirect_uris: ["https://c.example/cb"] }, headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address is unaffected, and the window resets.
    expect((await register({ redirect_uris: ["https://c.example/cb"] }, { "x-forwarded-for": "203.0.113.8" })).status).toBe(201);
    h.clock.advance(10 * 60 * 1000);
    expect((await register({ redirect_uris: ["https://c.example/cb"] }, headers)).status).toBe(201);
  });
});

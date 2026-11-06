import { describe, expect, test } from "bun:test";
import { OAuthHttp } from "./http";
import { OAuthMetadata } from "./metadata";

const ctx = { origin: "https://openrcs.example" };

describe("OAuth discovery metadata", () => {
  test("RFC 8414 authorization server document", async () => {
    const response = OAuthMetadata.authorizationServerResponse(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await response.json()).toEqual({
      issuer: "https://openrcs.example",
      authorization_endpoint: "https://openrcs.example/oauth/authorize",
      token_endpoint: "https://openrcs.example/oauth/token",
      registration_endpoint: "https://openrcs.example/oauth/register",
      revocation_endpoint: "https://openrcs.example/oauth/revoke",
      scopes_supported: ["messages:read", "messages:send"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  test("RFC 9728 protected resource document", async () => {
    const response = OAuthMetadata.protectedResourceResponse(ctx);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      resource: "https://openrcs.example/api/mcp",
      authorization_servers: ["https://openrcs.example"],
      scopes_supported: ["messages:read", "messages:send"],
      bearer_methods_supported: ["header"],
      resource_name: "openrcs",
    });
  });

  test("CORS preflight allows any origin without credentials", () => {
    const response = OAuthHttp.preflight("POST");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

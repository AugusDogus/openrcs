import { OAUTH_CLIENT_AUTH_METHODS } from "@/lib/db/vault-schema";
import { OAuthContext } from "./context";
import { OAuthHttp } from "./http";
import { McpScope } from "./scopes";

/** RFC 8414 authorization server metadata (also served as /.well-known/openid-configuration). */
const authorizationServer = (ctx: Pick<OAuthContext, "origin">) => ({
  issuer: ctx.origin,
  authorization_endpoint: `${ctx.origin}/oauth/authorize`,
  token_endpoint: `${ctx.origin}/oauth/token`,
  registration_endpoint: `${ctx.origin}/oauth/register`,
  revocation_endpoint: `${ctx.origin}/oauth/revoke`,
  scopes_supported: [...McpScope.all],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
  revocation_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
});

/** RFC 9728 protected resource metadata for the MCP endpoint. */
const protectedResource = (ctx: Pick<OAuthContext, "origin">) => ({
  resource: OAuthContext.mcpResource(ctx),
  authorization_servers: [ctx.origin],
  scopes_supported: [...McpScope.all],
  bearer_methods_supported: ["header"],
  resource_name: "openrcs",
});

const document = (body: unknown): Response =>
  Response.json(body, {
    headers: { ...OAuthHttp.corsHeaders, "Cache-Control": "public, max-age=300" },
  });

export const OAuthMetadata = {
  authorizationServer,
  protectedResource,
  authorizationServerResponse: (ctx: Pick<OAuthContext, "origin">): Response =>
    document(authorizationServer(ctx)),
  protectedResourceResponse: (ctx: Pick<OAuthContext, "origin">): Response =>
    document(protectedResource(ctx)),
} as const;

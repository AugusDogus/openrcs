import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";
import { Env } from "@/lib/env";
import { McpScope } from "@/lib/mcp/scopes";
import { createRcsMcpServer } from "@/lib/mcp/server";

export const maxDuration = 120;

/** Verified access-token claims as passed by `requireMcpAuth`. */
type AccessTokenClaims = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];

const jsonRpcError = (status: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });

const bearerToken = (request: Request): string => {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^(Bearer|DPoP)\s+/i, "");
};

/** Verified JWT claims -> the SDK's AuthInfo, so tool callbacks can read granted scopes. */
const toAuthInfo = (request: Request, claims: AccessTokenClaims, resource: string): AuthInfo => ({
  token: bearerToken(request),
  clientId: typeof claims.azp === "string" ? claims.azp : "",
  scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
  expiresAt: claims.exp,
  resource: new URL(resource),
});

const serveMcp = async (request: Request, claims: AccessTokenClaims): Promise<Response> => {
  const userId = claims.sub;
  if (typeof userId !== "string" || userId.length === 0) {
    return jsonRpcError(
      403,
      "This access token is not bound to a user. Authorize the MCP client with the authorization-code flow (sign in to openrcs) and retry.",
    );
  }
  const handler = createMcpHandler(() => createRcsMcpServer({ userId }), {
    onerror: (error) => console.error(`[mcp] ${error.name}: ${error.message}`),
  });
  return handler.fetch(request, {
    authInfo: toAuthInfo(request, claims, Env.mcpResourceUrl()),
  });
};

let protectedHandler: ((request: Request) => Promise<Response>) | undefined;

const handle = async (request: Request): Promise<Response> => {
  await connection();
  protectedHandler ??= requireMcpAuth(getAuth(), serveMcp, {
    resource: Env.mcpResourceUrl(),
    challengeScopes: McpScope.all,
  });
  return protectedHandler(request);
};

export { handle as DELETE, handle as GET, handle as POST };

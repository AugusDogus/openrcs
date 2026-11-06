import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { connection } from "next/server";
import { OAuthContext } from "@/lib/oauth/context";
import { McpAuth } from "@/lib/oauth/mcp-auth";
import { createRcsMcpServer } from "@/lib/mcp/server";

/** Sends and syncs talk to the phone over a long poll, which can take minutes. */
export const maxDuration = 300;

/**
 * Remote MCP endpoint. Every request must carry an access token from our
 * OAuth server (docs/security.md); the verified grant (with the user's DEK)
 * is handed to a fresh per-request MCP server.
 */
const handle = async (request: Request): Promise<Response> => {
  await connection();
  const ctx = OAuthContext.fromEnv();
  const authenticated = await McpAuth.authenticate(ctx, request);
  if (authenticated.isErr()) {
    const error = authenticated.error;
    if (error._tag === "OAuthStorageError") {
      console.error(`[mcp] ${error.operation} failed`);
      return McpAuth.unavailableResponse();
    }
    return McpAuth.unauthorizedResponse(ctx, error);
  }
  const auth = authenticated.value;
  const authInfo: AuthInfo = {
    token: McpAuth.bearerToken(request) ?? "",
    clientId: auth.clientId,
    scopes: [...auth.scopes],
    resource: new URL(OAuthContext.mcpResource(ctx)),
  };
  const handler = createMcpHandler(() => createRcsMcpServer({ auth }), {
    // Names only: SDK messages can echo request content (message bodies, numbers).
    onerror: (error) => console.error(`[mcp] request failed: ${error.name}`),
  });
  return handler.fetch(request, { authInfo });
};

export { handle as DELETE, handle as GET, handle as POST };

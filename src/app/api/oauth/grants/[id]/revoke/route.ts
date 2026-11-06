import { OAuthContext } from "@/lib/oauth/context";
import { GrantRevocation } from "@/lib/oauth/grant-revocation";

/** Dashboard "Revoke" for one connected MCP client (session-authenticated, same-origin). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/oauth/grants/[id]/revoke">,
): Promise<Response> {
  const { id } = await ctx.params;
  return GrantRevocation.handle(OAuthContext.fromEnv(), request, id);
}

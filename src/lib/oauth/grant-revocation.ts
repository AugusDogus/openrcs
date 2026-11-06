import { AuthorizeEndpoint } from "./authorize";
import type { OAuthContext } from "./context";
import { OAuthGrants } from "./grants";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";

/**
 * POST /api/oauth/grants/[id]/revoke from the dashboard's Connected clients
 * form. Same-origin only, signed-in user only, and only the user's own grant.
 * Redirects back to the dashboard on success.
 */
const handle = async (ctx: OAuthContext, request: Request, grantId: string): Promise<Response> => {
  if (request.headers.get("origin") !== ctx.origin) {
    return OAuthHttp.htmlError(403, "Request blocked", "This request did not come from the openrcs dashboard. Nothing was revoked.");
  }
  const session = await AuthorizeEndpoint.sessionOf(ctx, request.headers);
  if (session.isErr()) {
    return OAuthHttp.htmlError(503, "Try again", "openrcs could not check your session right now. Nothing was revoked; go back and try again.");
  }
  if (session.value === null) {
    return OAuthHttp.htmlError(401, "Signed out", "Sign in again to manage connected clients. Nothing was revoked.");
  }
  const revoked = await OAuthGrants.revokeOwned(ctx.db, session.value.userId, grantId, ctx.vault.now());
  if (revoked.isErr()) {
    OAuthLog.failure(revoked.error.operation, revoked.error.cause);
    return OAuthHttp.htmlError(503, "Try again", "openrcs could not revoke this client right now. It is still connected; go back and try again.");
  }
  if (!revoked.value) {
    return OAuthHttp.htmlError(404, "Not found", "That connected client does not exist or belongs to another account. Nothing was revoked.");
  }
  return OAuthHttp.seeOther("/dashboard");
};

export const GrantRevocation = { handle } as const;

import { OAuthContext } from "@/lib/oauth/context";
import { OAuthHttp } from "@/lib/oauth/http";
import { RevokeEndpoint } from "@/lib/oauth/revoke-endpoint";

/** RFC 7009 token revocation. */
export async function POST(request: Request): Promise<Response> {
  return RevokeEndpoint.handle(OAuthContext.fromEnv(), request);
}

export function OPTIONS(): Response {
  return OAuthHttp.preflight("POST");
}

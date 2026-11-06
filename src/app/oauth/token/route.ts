import { OAuthContext } from "@/lib/oauth/context";
import { OAuthHttp } from "@/lib/oauth/http";
import { TokenEndpoint } from "@/lib/oauth/token-endpoint";

/** OAuth 2.1 token endpoint: authorization_code (PKCE) and refresh_token (rotation). */
export async function POST(request: Request): Promise<Response> {
  return TokenEndpoint.handle(OAuthContext.fromEnv(), request);
}

export function OPTIONS(): Response {
  return OAuthHttp.preflight("POST");
}

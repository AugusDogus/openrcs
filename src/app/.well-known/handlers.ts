import { connection } from "next/server";
import { OAuthContext } from "@/lib/oauth/context";
import { OAuthHttp } from "@/lib/oauth/http";
import { OAuthMetadata } from "@/lib/oauth/metadata";

/**
 * OAuth discovery documents (docs/security.md). The issuer is the app
 * origin. `connection()` keeps them out of build-time prerendering (they need
 * BETTER_AUTH_URL). CORS allows any origin without credentials.
 */
export const WellKnown = {
  /** RFC 8414 (also served at /.well-known/openid-configuration). */
  authorizationServer: async (): Promise<Response> => {
    await connection();
    return OAuthMetadata.authorizationServerResponse(OAuthContext.originFromEnv());
  },
  /** RFC 9728, at the root and the /api/mcp path-suffixed location. */
  protectedResource: async (): Promise<Response> => {
    await connection();
    return OAuthMetadata.protectedResourceResponse(OAuthContext.originFromEnv());
  },
  preflight: (): Response => OAuthHttp.preflight("GET"),
} as const;

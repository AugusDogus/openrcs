import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { connection } from "next/server";
import { getAuth } from "@/lib/auth";

/**
 * OAuth discovery documents served on the app origin, outside Better Auth's
 * `/api/auth` mount. The issuer is `${BETTER_AUTH_URL}/api/auth`; the
 * `/api/auth/.well-known/*` variants are served by the auth catch-all route.
 * `connection()` keeps these out of build-time prerendering (they need env).
 */
export const Discovery = {
  /**
   * RFC 9728 protected-resource metadata for the MCP resource. The `mcp()`
   * plugin answers these paths from Better Auth's request hook, so forward the
   * request unchanged.
   */
  protectedResource: async (request: Request): Promise<Response> => {
    await connection();
    return getAuth().handler(request);
  },
  /** RFC 8414 authorization-server metadata. */
  authorizationServer: async (request: Request): Promise<Response> => {
    await connection();
    return oauthProviderAuthServerMetadata(getAuth())(request);
  },
  /** OpenID Connect discovery. */
  openIdConfiguration: async (request: Request): Promise<Response> => {
    await connection();
    return oauthProviderOpenIdConfigMetadata(getAuth())(request);
  },
} as const;

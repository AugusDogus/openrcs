import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. `oauthProviderClient` forwards the signed OAuth query
 * from the current URL on sign-in, sign-up and consent requests, so an MCP
 * authorization flow resumes automatically after the user signs in.
 */
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});

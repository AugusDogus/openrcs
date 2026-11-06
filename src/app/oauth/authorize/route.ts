import { connection } from "next/server";
import { AuthorizeEndpoint } from "@/lib/oauth/authorize";
import { OAuthContext } from "@/lib/oauth/context";

/** OAuth 2.1 authorization endpoint (docs/security.md). */
export async function GET(request: Request): Promise<Response> {
  await connection();
  return AuthorizeEndpoint.handle(OAuthContext.fromEnv(), request);
}

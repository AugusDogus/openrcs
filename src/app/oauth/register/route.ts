import { OAuthClients } from "@/lib/oauth/clients";
import { OAuthContext } from "@/lib/oauth/context";
import { OAuthHttp } from "@/lib/oauth/http";

/** RFC 7591 dynamic client registration. */
export async function POST(request: Request): Promise<Response> {
  return OAuthClients.register(OAuthContext.fromEnv(), request);
}

export function OPTIONS(): Response {
  return OAuthHttp.preflight("POST");
}

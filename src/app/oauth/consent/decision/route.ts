import { ConsentFlow } from "@/lib/oauth/consent";
import { OAuthContext } from "@/lib/oauth/context";

/** Consent form target: approve or deny (Origin check + single-use consent ticket). */
export async function POST(request: Request): Promise<Response> {
  return ConsentFlow.decide(OAuthContext.fromEnv(), request);
}

import { connection } from "next/server";
import { handlePairingBrowserAuthorize } from "@/lib/pairing-browser/http";

/** nginx auth_request for the sign-in browser stream (docker/root/defaults/default.conf). */
export async function GET(request: Request): Promise<Response> {
  // Never prerender: the answer depends on the session and the browser right now.
  await connection();
  return handlePairingBrowserAuthorize(request);
}

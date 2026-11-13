import { connection } from "next/server";
import { handlePairingBrowserAuthorize } from "@/lib/pairing-browser/http";

/** nginx auth_request for the sign-in browser stream (docker/root/defaults/default.conf). */
export async function GET(request: Request): Promise<Response> {
  // Never prerender: whether the browser is enabled is only known at run time.
  await connection();
  return handlePairingBrowserAuthorize(request);
}

import { getDb } from "@/lib/db/client";
import { PairingBrowser } from "@/lib/pairing-browser/pairing-browser";
import { describeForLog } from "./errors";
import { pairingResponseHeaders, startPairing } from "./pairing";
import { RequestGuard } from "./request-guard";

/**
 * Route-level glue for the pairing endpoint: guards, the cookies the sign-in
 * browser captured for this user, and the SSE response.
 */

/** POST handler body of /api/pair/gaia. */
export const handlePairingRequest = async (request: Request): Promise<Response> => {
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);

  const cookies = await PairingBrowser.fromEnv().take(signedIn.value.userId);
  if (cookies === null) {
    return RequestGuard.errorResponse(
      409,
      "openrcs has no Google sign-in from the pairing browser (it is kept for 5 minutes). Sign in again.",
    );
  }

  const started = await startPairing(getDb(), {
    userId: signedIn.value.userId,
    cookies,
    signal: request.signal,
  });
  if (started.isErr()) {
    const error = started.error;
    if (error._tag === "RcsPhoneBusyError") return RequestGuard.errorResponse(409, error.message);
    console.error(`[api:pair] could not start pairing: ${describeForLog(error)}`);
    return RequestGuard.errorResponse(
      503,
      "openrcs could not start pairing because the database did not respond. Nothing was changed; try again in a moment.",
    );
  }
  return new Response(started.value.stream, {
    status: 200,
    headers: pairingResponseHeaders(),
  });
};

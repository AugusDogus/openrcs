import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { GoogleCookies } from "@/lib/gm/google-cookies";
import { PairingBrowser } from "@/lib/pairing-browser/pairing-browser";
import { describeForLog } from "./errors";
import { pairingResponseHeaders, startPairing } from "./pairing";
import { RequestGuard } from "./request-guard";

/** Route-level glue for the pairing endpoint: guards, body parsing, SSE response. */

const MAX_BODY_BYTES = 64 * 1024;

const GaiaBodySchema = z.union([
  z.object({ cookies: z.string() }),
  // Cookies captured by the self-hosted sign-in browser (src/lib/pairing-browser).
  z.object({ source: z.literal("browser") }),
]);

const bodyHint = (): string =>
  PairingBrowser.enabled()
    ? 'Expected {"source": "browser"}: this openrcs pairs from its sign-in browser.'
    : 'Expected a JSON body like {"cookies": "<pasted cURL command>"}.';

const parseGaiaBody = async (request: Request, userId: string): Promise<GoogleCookies | Response> => {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return RequestGuard.errorResponse(
      413,
      "The pasted text is too large. Paste only the cURL command for one request to messages.google.com.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return RequestGuard.errorResponse(400, bodyHint());
  }
  const body = GaiaBodySchema.safeParse(json);
  if (!body.success) return RequestGuard.errorResponse(400, bodyHint());
  // One way per deployment: the self-hosted sign-in browser, or (hosted) a pasted cURL command.
  const browser = PairingBrowser.fromEnv();
  if (browser.isOk() !== ("source" in body.data)) return RequestGuard.errorResponse(400, bodyHint());
  if ("source" in body.data) {
    if (browser.isErr()) return RequestGuard.errorResponse(404, browser.error.message);
    const taken = await browser.value.take(userId);
    return (
      taken ??
      RequestGuard.errorResponse(
        409,
        "openrcs has no Google sign-in from the pairing browser (it is kept for 5 minutes). Sign in again.",
      )
    );
  }
  const cookies = GoogleCookies.parse(body.data.cookies);
  if (cookies.isErr()) return RequestGuard.errorResponse(400, cookies.error.message);
  return cookies.value;
};

/** POST handler body of /api/pair/gaia. */
export const handlePairingRequest = async (request: Request): Promise<Response> => {
  const startedAt = Date.now();
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);

  const cookies = await parseGaiaBody(request, signedIn.value.userId);
  if (cookies instanceof Response) return cookies;

  const started = await startPairing(getDb(), {
    userId: signedIn.value.userId,
    cookieHeader: signedIn.value.cookieHeader,
    cookies,
    signal: request.signal,
    startedAt,
  });
  if (started.isErr()) {
    const error = started.error;
    if (error._tag === "RcsPhoneBusyError") return RequestGuard.errorResponse(409, error.message);
    console.error(`[api:pair] could not start pairing: ${describeForLog(error)}`);
    return RequestGuard.errorResponse(
      503,
      error._tag === "VaultLockedError"
        ? error.message
        : "openrcs could not start pairing because the database did not respond. Nothing was changed; try again in a moment.",
    );
  }
  return new Response(started.value.stream, {
    status: 200,
    headers: pairingResponseHeaders(started.value.setCookie),
  });
};

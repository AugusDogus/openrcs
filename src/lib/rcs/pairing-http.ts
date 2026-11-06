import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { GoogleCookies } from "@/lib/gm/google-cookies";
import { describeForLog } from "./errors";
import { pairingResponseHeaders, startPairing, type PairingMethod } from "./pairing";
import { RequestGuard } from "./request-guard";

/** Route-level glue for the pairing endpoints: guards, body parsing, SSE response. */

const MAX_BODY_BYTES = 64 * 1024;

const GaiaBodySchema = z.object({ cookies: z.string() });

const parseGaiaBody = async (request: Request): Promise<PairingMethod | Response> => {
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
    return RequestGuard.errorResponse(400, 'Expected a JSON body like {"cookies": "<pasted cURL command>"}.');
  }
  const body = GaiaBodySchema.safeParse(json);
  if (!body.success) {
    return RequestGuard.errorResponse(400, 'Expected a JSON body like {"cookies": "<pasted cURL command>"}.');
  }
  const cookies = GoogleCookies.parse(body.data.cookies);
  if (cookies.isErr()) return RequestGuard.errorResponse(400, cookies.error.message);
  return { kind: "gaia", cookies: cookies.value };
};

/** POST handler body shared by /api/pair/gaia and /api/pair/qr. */
export const handlePairingRequest = async (
  request: Request,
  kind: PairingMethod["kind"],
): Promise<Response> => {
  const startedAt = Date.now();
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);

  const method = kind === "gaia" ? await parseGaiaBody(request) : { kind: "qr" as const };
  if (method instanceof Response) return method;

  const started = await startPairing(getDb(), {
    userId: signedIn.value.userId,
    cookieHeader: signedIn.value.cookieHeader,
    method,
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

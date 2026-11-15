import { Result } from "better-result";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { PairingBrowser, type PairingBrowserError } from "./pairing-browser";

/** Route glue for the self-hosted sign-in browser (POST /api/pair/browser, GET /api/pair/browser/authorize). */

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), colorScheme: z.enum(["light", "dark"]) }),
  z.object({ action: z.enum(["poll", "stop"]) }),
]);

const statusFor = (error: PairingBrowserError): number => {
  switch (error.reason) {
    case "busy":
      return 409;
    case "launch":
    case "cookies":
      return 500;
  }
};

const noStore = (response: Response): Response => {
  response.headers.set("cache-control", "no-store");
  return response;
};

/** POST /api/pair/browser with `{ action }`: start, poll or stop. */
export const handlePairingBrowserAction = async (request: Request): Promise<Response> => {
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);
  const body = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return RequestGuard.errorResponse(
      400,
      'Expected a JSON body like {"action": "start", "colorScheme": "dark"} or {"action": "poll"} (or "stop").',
    );
  }
  const userId = signedIn.value.userId;
  const b = PairingBrowser.fromEnv();
  const action = body.data;
  if (action.action === "stop") {
    await b.stop(userId);
    return noStore(Response.json({ status: "idle" }));
  }
  const result = action.action === "start" ? await b.start(userId, action.colorScheme) : await b.poll(userId);
  if (result.isErr()) {
    if (result.error.reason === "launch" || result.error.reason === "cookies") {
      console.error(`[pairing-browser] ${action.action} failed: ${result.error.reason}`);
    }
    return RequestGuard.errorResponse(statusFor(result.error), result.error.message);
  }
  return noStore(Response.json(result.value));
};

/**
 * GET /api/pair/browser/authorize: nginx `auth_request` for the browser
 * stream (/pairing-browser/). 204 only for the signed-in user who opened the
 * browser and only while it is open; no Origin check, because the iframe and
 * its WebSocket are not fetch() calls.
 */
export const handlePairingBrowserAuthorize = async (request: Request): Promise<Response> => {
  const session = await Result.tryPromise({
    try: () => getAuth().api.getSession({ headers: request.headers }),
    catch: () => null,
  });
  if (session.isErr() || session.value === null) return noStore(new Response(null, { status: 401 }));
  return noStore(new Response(null, { status: PairingBrowser.fromEnv().canView(session.value.user.id) ? 204 : 403 }));
};

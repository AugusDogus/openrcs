import { Result } from "better-result";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { PairingBrowser, type PairingBrowserError } from "./pairing-browser";

/** Route glue for the self-hosted sign-in browser (POST /api/pair/browser, GET /api/pair/browser/authorize). */

const ActionSchema = z.object({ action: z.enum(["start", "poll", "stop"]) });

const statusFor = (error: PairingBrowserError): number => {
  switch (error.reason) {
    case "disabled":
      return 404;
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
  const browser = PairingBrowser.fromEnv();
  if (browser.isErr()) return RequestGuard.errorResponse(statusFor(browser.error), browser.error.message);

  const body = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return RequestGuard.errorResponse(400, 'Expected a JSON body like {"action": "start"} (start, poll or stop).');
  }
  const userId = signedIn.value.userId;
  const b = browser.value;
  if (body.data.action === "stop") {
    await b.stop(userId);
    return noStore(Response.json({ status: "idle" }));
  }
  const result = body.data.action === "start" ? await b.start(userId) : await b.poll(userId);
  if (result.isErr()) {
    if (result.error.reason === "launch" || result.error.reason === "cookies") {
      console.error(`[pairing-browser] ${body.data.action} failed: ${result.error.reason}`);
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
  const browser = PairingBrowser.fromEnv();
  if (browser.isErr()) return noStore(new Response(null, { status: 404 }));
  const session = await Result.tryPromise({
    try: () => getAuth().api.getSession({ headers: request.headers }),
    catch: () => null,
  });
  if (session.isErr() || session.value === null) return noStore(new Response(null, { status: 401 }));
  return noStore(new Response(null, { status: browser.value.canView(session.value.user.id) ? 204 : 403 }));
};

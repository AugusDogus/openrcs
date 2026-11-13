import { Result } from "better-result";
import { AuthorizationRequest } from "./authorization-request";
import type { BrowserSession, OAuthContext } from "./context";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";

const unavailable = () =>
  OAuthHttp.htmlError(
    503,
    "Authorization unavailable",
    "openrcs could not check this request right now. Nothing was shared. Try again in a moment.",
  );

/** Same-origin relative sign-in URL that resumes `returnTo` afterwards. */
const signInUrl = (returnTo: string): string =>
  `/sign-in?${new URLSearchParams({ callbackURL: returnTo }).toString()}`;

/** Browser session or an error response, never throwing. */
const sessionOf = async (
  ctx: OAuthContext,
  headers: Headers,
): Promise<Result<BrowserSession | null, "unavailable">> => {
  const session = await Result.tryPromise(() => ctx.getSession(headers));
  if (session.isErr()) {
    OAuthLog.failure("load browser session", session.error.cause);
    return Result.err("unavailable");
  }
  return Result.ok(session.value);
};

const found = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

/**
 * GET /oauth/authorize. Validates the request (failures render an error
 * page), then sends the user to sign-in if needed and on to the
 * consent page. Errors are never redirected to the client: every redirect URI
 * comes from open dynamic registration, so an automatic error redirect would
 * make this origin an open redirector (RFC 9700 section 4.11.2). Only the
 * user's own consent decision redirects back to the client.
 */
const handle = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const validated = await AuthorizationRequest.validate(ctx, url.searchParams);
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return OAuthHttp.htmlError(400, "Cannot authorize this app", error.message);
      case "AuthorizeRedirectError":
        return OAuthHttp.htmlError(
          400,
          "Cannot authorize this app",
          `This authorization request is invalid (${error.error}): ${error.description} Nothing was shared. Return to the app you were connecting and start again.`,
        );
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return unavailable();
    }
  }
  const session = await sessionOf(ctx, request.headers);
  if (session.isErr()) return unavailable();
  if (session.value === null) return found(signInUrl(`${url.pathname}${url.search}`));
  const consent = AuthorizationRequest.toSearchParams(validated.value.request);
  return found(`/oauth/consent?${consent.toString()}`);
};

export const AuthorizeEndpoint = { handle, signInUrl, sessionOf } as const;

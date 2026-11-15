import { Result, TaggedError } from "better-result";
import { getAuth } from "@/lib/auth";
import { Env } from "@/lib/env";

/**
 * Checks shared by the dashboard's state-changing routes (pairing, sync,
 * unpair, account deletion): the request must come from our own origin
 * (CSRF defense on top of SameSite cookies) and carry a Better Auth session.
 */
export type SignedInRequest = { readonly userId: string };

export class RequestRejectedError extends TaggedError("RequestRejectedError")<{
  status: 401 | 403 | 503;
  message: string;
}> {}

/** True when `Origin` is exactly the app origin derived from BETTER_AUTH_URL. */
const isSameOrigin = (request: Request, appOrigin: string): boolean =>
  request.headers.get("origin") === appOrigin;

const appOrigin = (): string => new URL(Env.auth().BETTER_AUTH_URL).origin;

const requireSignedIn = async (
  request: Request,
): Promise<Result<SignedInRequest, RequestRejectedError>> => {
  if (!isSameOrigin(request, appOrigin())) {
    return Result.err(
      new RequestRejectedError({
        status: 403,
        message:
          "This request did not come from the openrcs dashboard, so it was refused. Nothing was changed. Reload the dashboard and try again.",
      }),
    );
  }
  const session = await Result.tryPromise({
    try: () => getAuth().api.getSession({ headers: request.headers }),
    catch: () =>
      new RequestRejectedError({
        status: 503,
        message:
          "openrcs could not check your sign-in because the database did not respond. Nothing was changed; try again in a moment.",
      }),
  });
  if (session.isErr()) return Result.err(session.error);
  if (session.value === null) {
    return Result.err(
      new RequestRejectedError({
        status: 401,
        message: "You are signed out. Sign in to openrcs again, then retry.",
      }),
    );
  }
  return Result.ok({ userId: session.value.user.id });
};

/** JSON error body `{ error }` with no-store caching. */
const errorResponse = (status: number, message: string, headers?: HeadersInit): Response => {
  const response = Response.json({ error: message }, { status, headers });
  response.headers.set("cache-control", "no-store");
  return response;
};

export const RequestGuard = { isSameOrigin, appOrigin, requireSignedIn, errorResponse } as const;

import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/** Pages with approve/revoke buttons must not be framed (clickjacking). */
const frameProtection: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/**
 * Optimistic redirects from the session cookie's presence only (no database
 * lookup). Pages still validate the session and redirect to /sign-in when the
 * cookie is stale. The OAuth consent page does its own session check.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = getSessionCookie(request) !== null;
  const { pathname, search } = request.nextUrl;

  if (pathname === "/") {
    return NextResponse.redirect(new URL(hasSessionCookie ? "/dashboard" : "/sign-in", request.url));
  }
  if (pathname.startsWith("/dashboard") && !hasSessionCookie) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("callbackURL", `${pathname}${search}`);
    return NextResponse.redirect(signIn);
  }
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(frameProtection)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/oauth/consent", "/sign-in"],
};

import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirects from the session cookie's presence only (no database
 * lookup). Pages still validate the session and redirect to /sign-in when the
 * cookie is stale.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = getSessionCookie(request) !== null;
  const { pathname } = request.nextUrl;

  if (pathname === "/") {
    return NextResponse.redirect(new URL(hasSessionCookie ? "/dashboard" : "/sign-in", request.url));
  }
  if (!hasSessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};

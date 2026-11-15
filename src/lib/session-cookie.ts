import { getSessionCookie } from "better-auth/cookies";

/**
 * openrcs's browser session cookie. Its own prefix keeps other Better Auth apps
 * on the same host name (Tailscale Serve ports on one machine, such as
 * Executor) from overwriting it, since cookies ignore ports. Light enough for
 * the proxy: no database or secrets.
 */
export const SessionCookie = {
  prefix: "openrcs",
  /** Whether the request carries a session cookie at all (not whether it is valid). */
  isPresent: (request: Request | Headers): boolean =>
    getSessionCookie(request, { cookiePrefix: SessionCookie.prefix }) !== null,
} as const;

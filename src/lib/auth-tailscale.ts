import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * Sign-in for a self-hosted openrcs that is reachable only through Tailscale
 * Serve. Serve adds `Tailscale-User-Login` / `Tailscale-User-Name` to every
 * proxied tailnet request and strips any copy the client sent, so the header
 * is trustworthy exactly when nothing but Serve can reach the app: the server
 * must listen on loopback only (docs/self-hosting.md). Tagged devices and
 * Funnel traffic carry no identity and cannot sign in.
 *
 * The endpoint only turns that identity into an ordinary Better Auth session
 * cookie; everything after sign-in is ordinary Better Auth.
 */
export const TAILSCALE_PROVIDER_ID = "tailscale";

export type TailscaleIdentity = { readonly login: string; readonly name: string };

const MAX_LOGIN_LENGTH = 254;

/** RFC 2047 "Q" words (`=?utf-8?q?...?=`), which Serve uses for non-ASCII names. */
const decodeQWord = (value: string): string | null => {
  const match = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded.replace(/_/g, " ").replace(/%/g, "%25").replace(/=([0-9A-Fa-f]{2})/g, "%$1"));
  } catch {
    return null;
  }
};

/** The caller's tailnet identity from Serve's headers, or `null` when absent or malformed. */
const identityFromHeaders = (headers: Headers): TailscaleIdentity | null => {
  const login = headers.get("tailscale-user-login")?.trim().toLowerCase() ?? "";
  // Logins look like `alice@example.com` or `alice@github`.
  if (login.length === 0 || login.length > MAX_LOGIN_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(login)) return null;
  const rawName = headers.get("tailscale-user-name")?.trim() ?? "";
  const name = (decodeQWord(rawName) ?? rawName).slice(0, 200);
  return { login, name: name === "" || name.startsWith("=?") ? (login.split("@")[0] ?? login) : name };
};

export const TailscaleIdentity = { fromHeaders: identityFromHeaders } as const;

export const tailscaleSignIn = () => ({
  id: "tailscale-sign-in",
  endpoints: {
    signInTailscale: createAuthEndpoint("/sign-in/tailscale", { method: "POST" }, async (ctx) => {
      const identity = ctx.headers ? identityFromHeaders(ctx.headers) : null;
      if (identity === null) {
        throw new APIError("UNAUTHORIZED", {
          message:
            "This request carried no Tailscale identity. Open openrcs through its Tailscale Serve address from a device signed in to your tailnet as a user (tagged devices have no identity).",
        });
      }
      const { internalAdapter } = ctx.context;
      const key = { providerId: TAILSCALE_PROVIDER_ID, accountId: identity.login };
      const owner = await internalAdapter.findAccountOwnerByKey(key);
      let user = owner?.kind === "owned" ? owner.user : null;
      if (user === null) {
        // Same address already has a user (e.g. created by an older openrcs).
        const byEmail = await internalAdapter.findUserByEmail(identity.login);
        if (byEmail) {
          await internalAdapter.linkAccount({ ...key, userId: byEmail.user.id });
          user = byEmail.user;
        }
      }
      if (user === null) {
        const created = await internalAdapter.createOAuthUser(
          { email: identity.login, name: identity.name, emailVerified: true },
          key,
        );
        user = created.user;
      }
      const session = await internalAdapter.createSession(user.id);
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
    }),
  },
});

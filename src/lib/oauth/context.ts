import { getAuth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db/client";
import { Env } from "@/lib/env";
import { VaultConfig } from "@/lib/vault/config";

/** The signed-in browser user (Better Auth session). */
export type BrowserSession = { readonly userId: string; readonly sessionId: string };

/**
 * Dependencies of the OAuth server's request handlers. Route files use
 * `OAuthContext.fromEnv()`; tests build one around a temp database, a fixed
 * clock and a test-only Better Auth instance.
 */
export type OAuthContext = {
  readonly db: Database;
  /** Issuer: the public origin, no trailing slash (e.g. https://openrcs.vercel.app). */
  readonly origin: string;
  readonly vault: VaultConfig;
  /** Secret for signing consent tickets (BETTER_AUTH_SECRET). Never log. */
  readonly ticketSecret: string;
  /** Resolves the Better Auth session from request headers; throws on storage failure. */
  readonly getSession: (headers: Headers) => Promise<BrowserSession | null>;
};

let cached: OAuthContext | undefined;

export const OAuthContext = {
  /** Throws `InvalidEnvError` naming missing variables (deployment misconfiguration). */
  fromEnv: (): OAuthContext => {
    if (cached) return cached;
    const env = Env.auth();
    cached = {
      db: getDb(),
      origin: new URL(env.BETTER_AUTH_URL).origin,
      vault: VaultConfig.fromEnv(),
      ticketSecret: env.BETTER_AUTH_SECRET,
      getSession: async (headers) => {
        const session = await getAuth().api.getSession({ headers });
        return session ? { userId: session.user.id, sessionId: session.session.id } : null;
      },
    };
    return cached;
  },
  /** Just the issuer origin (for metadata documents, which need no database or vault key). */
  originFromEnv: (): Pick<OAuthContext, "origin"> => ({
    origin: new URL(Env.auth().BETTER_AUTH_URL).origin,
  }),
  /** RFC 8707 resource identifier of the MCP endpoint. */
  mcpResource: (ctx: Pick<OAuthContext, "origin">): string => `${ctx.origin}/api/mcp`,
  protectedResourceMetadataUrl: (ctx: Pick<OAuthContext, "origin">): string =>
    `${ctx.origin}/.well-known/oauth-protected-resource/api/mcp`,
  now: (ctx: Pick<OAuthContext, "vault">): number => ctx.vault.now(),
} as const;

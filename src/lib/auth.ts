import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { Env } from "@/lib/env";

/**
 * Better Auth handles GitHub sign-in and browser sessions only. MCP clients
 * authenticate through our own OAuth server in `src/lib/oauth`, whose tokens
 * carry a client-held key share (docs/security.md).
 */
export type AuthConfig = {
  /** Public origin without trailing slash, e.g. `https://openrcs.vercel.app`. */
  readonly baseURL: string;
  readonly secret: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  readonly database: ReturnType<typeof drizzleAdapter>;
};

/**
 * openrcs never calls GitHub after sign-in, so provider tokens are dropped
 * before every account write instead of sitting in the database (a dump
 * alone would otherwise yield working GitHub tokens).
 */
const withoutProviderTokens = { accessToken: null, refreshToken: null, idToken: null } as const;

export const createAuth = (config: AuthConfig) =>
  betterAuth({
    appName: "openrcs",
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.database,
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
      },
    },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...withoutProviderTokens } }) },
        update: { before: async (account) => ({ data: { ...account, ...withoutProviderTokens } }) },
      },
    },
    // Serverless instances do not share memory, so counters live in the database.
    rateLimit: {
      storage: "database",
    },
    // Must stay last so Set-Cookie from server actions reaches Next.
    plugins: [nextCookies()],
  });

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/**
 * The app's Better Auth instance, created on first use so `next build` does
 * not need secrets. Throws `InvalidEnvError` naming any missing variables.
 */
export const getAuth = (): Auth => {
  if (instance) return instance;
  const env = Env.auth();
  instance = createAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),
  });
  return instance;
};

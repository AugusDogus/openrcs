import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { tailscaleSignIn } from "@/lib/auth-tailscale";
import { Env } from "@/lib/env";

/**
 * Better Auth handles sign-in (GitHub, or Tailscale identity when
 * self-hosted) and browser sessions only. MCP clients
 * authenticate through our own OAuth server in `src/lib/oauth`, whose tokens
 * carry a client-held key share (docs/security.md).
 */
export type AuthConfig = {
  /** Public origin without trailing slash, e.g. `https://openrcs.vercel.app`. */
  readonly baseURL: string;
  readonly secret: string;
  readonly provider:
    | { readonly kind: "github"; readonly clientId: string; readonly clientSecret: string }
    | { readonly kind: "tailscale" };
  readonly database: ReturnType<typeof drizzleAdapter>;
};

/**
 * openrcs never calls GitHub after sign-in, so provider tokens are dropped
 * before every account write instead of sitting in the database (a dump
 * alone would otherwise yield working GitHub tokens).
 */
const withoutProviderTokens = { accessToken: null, refreshToken: null, idToken: null } as const;

/**
 * One Better Auth log argument, safe to print. Drizzle puts a failed query's
 * parameters (such as session tokens) in its error message, and Better Auth
 * logs that error as-is, so errors keep only their names and messages up to
 * "params:", and other values only their type.
 */
export const describeAuthLogArg = (arg: unknown): string => {
  if (!(arg instanceof Error)) return `<${typeof arg}>`;
  const parts: string[] = [];
  let current: unknown = arg;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const message = current.message.split("params:")[0]?.trim() ?? "";
    parts.push(`${current.name}: ${message.slice(0, 300)}`);
    current = current.cause;
  }
  return parts.join(" <- caused by ");
};

export const createAuth = (config: AuthConfig) =>
  betterAuth({
    appName: "openrcs",
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.database,
    socialProviders:
      config.provider.kind === "github"
        ? { github: { clientId: config.provider.clientId, clientSecret: config.provider.clientSecret } }
        : {},
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...withoutProviderTokens } }) },
        update: { before: async (account) => ({ data: { ...account, ...withoutProviderTokens } }) },
      },
    },
    logger: {
      log: (level, message, ...args: unknown[]) => {
        const details = args.map(describeAuthLogArg).join(" | ");
        console[level](`[better-auth] ${message}${details === "" ? "" : ` ${details}`}`);
      },
    },
    // Serverless instances do not share memory, so counters live in the database.
    rateLimit: {
      storage: "database",
    },
    // Must stay last so Set-Cookie from server actions reaches Next.
    plugins: [...(config.provider.kind === "tailscale" ? [tailscaleSignIn()] : []), nextCookies()],
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
    provider:
      env.AUTH_PROVIDER === "github"
        ? { kind: "github", clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : { kind: "tailscale" },
    database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),
  });
  return instance;
};

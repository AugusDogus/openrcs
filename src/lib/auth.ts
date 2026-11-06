import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { Env } from "@/lib/env";
import { McpScope } from "@/lib/mcp/scopes";

export const EMAIL_NOT_ALLOWED_CODE = "EMAIL_NOT_ALLOWED";

export const EMAIL_NOT_ALLOWED_MESSAGE =
  "Sign-up is invite-only and this email address is not on the allowlist. Ask the administrator to add it to ALLOWED_EMAILS, or sign up with an invited address.";

export type AuthConfig = {
  /** Public origin without trailing slash, e.g. `https://openrcs.vercel.app`. */
  readonly baseURL: string;
  readonly secret: string;
  /** Lowercased sign-up allowlist. */
  readonly allowedEmails: readonly string[];
  readonly database: ReturnType<typeof drizzleAdapter>;
};

export const isEmailAllowed = (email: string, allowedEmails: readonly string[]): boolean =>
  allowedEmails.includes(email.trim().toLowerCase());

export const createAuth = (config: AuthConfig) =>
  betterAuth({
    appName: "openrcs",
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.database,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    // Serverless instances do not share memory, so counters live in the database.
    rateLimit: {
      storage: "database",
    },
    // The JWT plugin's session-JWT endpoint shares the access-token signing key;
    // clients use /oauth2/token instead.
    disabledPaths: ["/token"],
    databaseHooks: {
      user: {
        create: {
          // Runs for every user-creation path (email sign-up, OAuth, admin APIs).
          before: async (user) => {
            if (!isEmailAllowed(user.email, config.allowedEmails)) {
              throw new APIError("FORBIDDEN", {
                message: EMAIL_NOT_ALLOWED_MESSAGE,
                code: EMAIL_NOT_ALLOWED_CODE,
              });
            }
          },
        },
      },
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        signup: { page: "/sign-up" },
        resource: `${config.baseURL}/api/mcp`,
        // Tokens must act for a user; no machine-to-machine client_credentials.
        grantTypes: ["authorization_code", "refresh_token"],
        scopes: [...McpScope.supported],
        clientRegistrationDefaultScopes: [...McpScope.registrationDefault],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Native MCP clients (loopback / custom-scheme callbacks) often omit application_type.
        clientRegistrationDefaultApplicationType: "infer",
        refreshTokenReuseInterval: 0,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      // Must stay last so Set-Cookie from server actions reaches Next.
      nextCookies(),
    ],
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
    allowedEmails: env.ALLOWED_EMAILS,
    database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),
  });
  return instance;
};

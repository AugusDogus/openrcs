import { Result, TaggedError } from "better-result";
import { z } from "zod";

/**
 * Server environment, validated with zod and split into sections so each
 * caller only requires the variables it actually uses (e.g. `db:migrate`
 * needs the database URL but not the auth secret). Sections are parsed
 * lazily on first access, so `next build` can import modules that use them
 * without secrets being present.
 */

const SESSION_KEY_BYTES = 32;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

const nonEmpty = (name: string) =>
  z.string({ error: `${name} is not set` }).trim().min(1, `${name} is empty`);

const AuthEnvSchema = z.object({
  BETTER_AUTH_URL: nonEmpty("BETTER_AUTH_URL")
    .pipe(z.url({ protocol: /^https?$/, error: "must be an absolute http(s) URL" }))
    .transform((value) => value.replace(/\/+$/, "")),
  BETTER_AUTH_SECRET: nonEmpty("BETTER_AUTH_SECRET").min(
    32,
    "must be at least 32 characters (generate one with `openssl rand -base64 32`)",
  ),
  ALLOWED_EMAILS: nonEmpty("ALLOWED_EMAILS")
    .transform((value) =>
      value
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    )
    .pipe(
      z
        .array(z.email({ error: "contains an entry that is not an email address" }))
        .min(1, "must list at least one email address"),
    ),
});

const DatabaseEnvSchema = z.object({
  TURSO_DATABASE_URL: nonEmpty("TURSO_DATABASE_URL").refine(
    (value) => /^(file|libsql|https?|wss?):/.test(value),
    "must start with file:, libsql://, http(s):// or ws(s)://",
  ),
  TURSO_AUTH_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value)),
});

const SecretBoxEnvSchema = z.object({
  SESSION_ENCRYPTION_KEY: nonEmpty("SESSION_ENCRYPTION_KEY").refine(
    (value) =>
      base64Pattern.test(value) &&
      Buffer.from(value, "base64").byteLength === SESSION_KEY_BYTES,
    `must be base64 that decodes to exactly ${SESSION_KEY_BYTES} bytes (generate one with \`openssl rand -base64 32\`)`,
  ),
});

const CronEnvSchema = z.object({
  CRON_SECRET: nonEmpty("CRON_SECRET").min(
    16,
    "must be at least 16 characters (generate one with `openssl rand -base64 32`)",
  ),
});

export type AuthEnv = z.infer<typeof AuthEnvSchema>;
export type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;
export type SecretBoxEnv = z.infer<typeof SecretBoxEnvSchema>;
export type CronEnv = z.infer<typeof CronEnvSchema>;

export type EnvSection = "auth" | "database" | "secretBox" | "cron";

export type EnvIssue = { readonly variable: string; readonly problem: string };

/** One or more environment variables are missing or malformed. */
export class InvalidEnvError extends TaggedError("InvalidEnvError")<{
  section: EnvSection;
  issues: readonly EnvIssue[];
  message: string;
}> {}

type EnvSource = Readonly<Record<string, string | undefined>>;

const describeIssues = (section: EnvSection, issues: readonly EnvIssue[]): string => {
  const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.problem}`);
  return [
    `Invalid server environment (${section}). The following variables need attention:`,
    ...lines,
    "Set them in .env.local for local development (see .env.example) or in the Vercel project settings, then restart the server.",
  ].join("\n");
};

const parseSection = <S extends z.ZodType>(
  section: EnvSection,
  schema: S,
  source: EnvSource,
): Result<z.infer<S>, InvalidEnvError> => {
  const parsed = schema.safeParse(source);
  if (parsed.success) return Result.ok(parsed.data);
  const issues = parsed.error.issues.map((issue) => ({
    variable: issue.path.map(String).join(".") || "(root)",
    problem: issue.message,
  }));
  return Result.err(
    new InvalidEnvError({ section, issues, message: describeIssues(section, issues) }),
  );
};

/**
 * Memoize a section parse against `process.env`. Throws at the framework
 * boundary: a missing variable is a deployment misconfiguration, not a
 * recoverable request-level failure, and the message names every variable to
 * fix.
 */
const lazySection = <T>(parse: (source: EnvSource) => Result<T, InvalidEnvError>) => {
  let cached: T | undefined;
  return (): T => {
    if (cached !== undefined) return cached;
    const value = parse(process.env).match({
      ok: (data) => data,
      err: (error) => {
        throw error;
      },
    });
    cached = value;
    return value;
  };
};

const parseAuth = (source: EnvSource) => parseSection("auth", AuthEnvSchema, source);
const parseDatabase = (source: EnvSource) =>
  parseSection("database", DatabaseEnvSchema, source);
const parseSecretBox = (source: EnvSource) =>
  parseSection("secretBox", SecretBoxEnvSchema, source);
const parseCron = (source: EnvSource) => parseSection("cron", CronEnvSchema, source);

export const Env = {
  /** BETTER_AUTH_URL (no trailing slash), BETTER_AUTH_SECRET, ALLOWED_EMAILS (lowercased). */
  auth: lazySection(parseAuth),
  /** TURSO_DATABASE_URL and optional TURSO_AUTH_TOKEN. */
  database: lazySection(parseDatabase),
  /** SESSION_ENCRYPTION_KEY (base64, 32 bytes). */
  secretBox: lazySection(parseSecretBox),
  /** CRON_SECRET. */
  cron: lazySection(parseCron),
  parseAuth,
  parseDatabase,
  parseSecretBox,
  parseCron,
  /** Canonical MCP resource URL: `${BETTER_AUTH_URL}/api/mcp`. */
  mcpResourceUrl: (): string => `${Env.auth().BETTER_AUTH_URL}/api/mcp`,
} as const;

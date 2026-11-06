/**
 * Server-side logging for the OAuth server. Database errors can carry query
 * parameters in their messages, so only error names and codes are logged,
 * never messages, tokens, secrets or user data.
 */

const codeOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
    ? value.code
    : undefined;

const describeCause = (cause: unknown): string => {
  if (!(cause instanceof Error)) return typeof cause;
  const inner = cause.cause instanceof Error ? cause.cause : undefined;
  return [cause.name, codeOf(cause), inner?.name, codeOf(inner)]
    .filter((part): part is string => typeof part === "string")
    .join(" / ");
};

export const OAuthLog = {
  failure: (operation: string, cause: unknown): void => {
    console.error(`[oauth] ${operation} failed: ${describeCause(cause)}`);
  },
} as const;

import { TaggedError } from "better-result";

/** A database read or write of the OAuth server failed. Committed state is intact. */
export class OAuthStorageError extends TaggedError("OAuthStorageError")<{
  operation: string;
  cause: unknown;
  message: string;
}> {}

/**
 * An RFC 6749 / 7591 / 7009 error to return to the client. `description` is
 * safe to show: it never contains secrets or user data.
 */
export class OAuthProtocolError extends TaggedError("OAuthProtocolError")<{
  status: number;
  error: string;
  description: string;
  message: string;
  /** Extra response headers, e.g. WWW-Authenticate for invalid_client. */
  headers?: Readonly<Record<string, string>>;
}> {}

export const OAuthErrors = {
  storage: (operation: string, cause: unknown) =>
    new OAuthStorageError({
      operation,
      cause,
      message: `OAuth server operation "${operation}" failed in the database. Nothing was issued or revoked by this request; retry, and check database connectivity (TURSO_DATABASE_URL) if it persists.`,
    }),
  protocol: (
    status: number,
    error: string,
    description: string,
    headers?: Readonly<Record<string, string>>,
  ) =>
    new OAuthProtocolError({
      status,
      error,
      description,
      message: `${error}: ${description}`,
      ...(headers ? { headers } : {}),
    }),
} as const;

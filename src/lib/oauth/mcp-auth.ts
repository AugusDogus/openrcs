import { Result, TaggedError } from "better-result";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { oauthGrant } from "@/lib/db/vault-schema";
import { OAuthContext } from "./context";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { OAuthHttp } from "./http";
import { McpScope } from "./scopes";
import { AccessToken } from "./tokens";

/** An authenticated MCP request (docs/vault-contract.md). */
export type McpAuth = {
  readonly userId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
};

/** No usable bearer token. `tokenPresent` decides whether the challenge carries error="invalid_token". */
export class McpUnauthorizedError extends TaggedError("McpUnauthorizedError")<{
  tokenPresent: boolean;
  reason: "missing" | "malformed" | "unauthentic" | "expired" | "revoked";
  message: string;
}> {}

const LAST_USED_RESOLUTION_MS = 60 * 1000;

const unauthorized = (
  tokenPresent: boolean,
  reason: McpUnauthorizedError["reason"],
  message: string,
) => Result.err(new McpUnauthorizedError({ tokenPresent, reason, message }));

const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
};

/**
 * Verifies "Authorization: Bearer oat_..." for /api/mcp: opens the sealed
 * token, checks expiry, then checks the grant is live for the same user and
 * client.
 */
const authenticate = async (
  ctx: OAuthContext,
  request: Request,
): Promise<Result<McpAuth, McpUnauthorizedError | OAuthStorageError>> => {
  const token = bearerToken(request);
  if (token === null) {
    return unauthorized(false, "missing", "Authorization required: send an OAuth access token as a Bearer token.");
  }
  const claims = AccessToken.open(ctx.vault.pepper, token);
  if (claims.isErr()) {
    return unauthorized(true, claims.error.reason, "The access token is invalid. Refresh it or authorize again.");
  }
  const now = ctx.vault.now();
  if (claims.value.exp * 1000 <= now) {
    return unauthorized(true, "expired", "The access token has expired. Refresh it with the refresh token.");
  }
  const { grantId, userId, clientId } = claims.value;
  const loaded = await Result.tryPromise({
    try: async () => {
      const [row] = await ctx.db
        .select({
          userId: oauthGrant.userId,
          clientId: oauthGrant.clientId,
          revokedAt: oauthGrant.revokedAt,
          lastUsedAt: oauthGrant.lastUsedAt,
        })
        .from(oauthGrant)
        .where(eq(oauthGrant.id, grantId))
        .limit(1);
      return row ?? null;
    },
    catch: (cause) => OAuthErrors.storage(`load grant ${grantId} for MCP request`, cause),
  });
  if (loaded.isErr()) return Result.err(loaded.error);
  const grant = loaded.value;
  if (!grant || grant.revokedAt !== null || grant.userId !== userId || grant.clientId !== clientId) {
    return unauthorized(true, "revoked", "This authorization was revoked. Authorize the client again.");
  }
  if (grant.lastUsedAt === null || grant.lastUsedAt <= now - LAST_USED_RESOLUTION_MS) {
    const touched = await Result.tryPromise({
      try: () =>
        ctx.db
          .update(oauthGrant)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(oauthGrant.id, grantId),
              or(isNull(oauthGrant.lastUsedAt), lte(oauthGrant.lastUsedAt, now - LAST_USED_RESOLUTION_MS)),
            ),
          ),
      catch: (cause) => OAuthErrors.storage(`update last_used_at of grant ${grantId}`, cause),
    });
    if (touched.isErr()) return Result.err(touched.error);
  }
  return Result.ok({ userId, grantId, clientId, scopes: claims.value.scopes });
};

const quote = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

/** 401 with the RFC 9728 challenge pointing MCP clients at our metadata. */
const unauthorizedResponse = (ctx: Pick<OAuthContext, "origin">, error: McpUnauthorizedError): Response => {
  const params = [
    ...(error.tokenPresent
      ? [`error=${quote("invalid_token")}`, `error_description=${quote(error.message)}`]
      : []),
    `resource_metadata=${quote(OAuthContext.protectedResourceMetadataUrl(ctx))}`,
  ];
  return OAuthHttp.json(
    error.tokenPresent
      ? { error: "invalid_token", error_description: error.message }
      : { error: "unauthorized", error_description: error.message },
    { status: 401, headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` } },
  );
};

/** 403 for a request whose token lacks `required` scopes (RFC 6750 section 3.1). */
const insufficientScope = (ctx: Pick<OAuthContext, "origin">, required: readonly McpScope[]): Response => {
  const scope = McpScope.format(required);
  const description = `This action needs the ${scope} scope. Re-authorize the client with that scope.`;
  return OAuthHttp.json(
    { error: "insufficient_scope", error_description: description, scope },
    {
      status: 403,
      headers: {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope=${quote(scope)}, resource_metadata=${quote(OAuthContext.protectedResourceMetadataUrl(ctx))}`,
      },
    },
  );
};

/** 503 when the grant check could not reach the database. */
const unavailableResponse = (): Response =>
  OAuthHttp.json(
    {
      error: "temporarily_unavailable",
      error_description: "openrcs could not verify the access token right now. Nothing was changed; retry shortly.",
    },
    { status: 503, headers: { "Retry-After": "5" } },
  );

export const McpAuth = {
  authenticate,
  unauthorizedResponse,
  insufficientScope,
  unavailableResponse,
  bearerToken,
} as const;

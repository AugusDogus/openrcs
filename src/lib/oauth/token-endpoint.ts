import { createHash } from "node:crypto";
import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { keySlot } from "@/lib/db/vault-schema";
import { Base64Url } from "@/lib/vault/base64url";
import type { Dek } from "@/lib/vault/dek";
import { KeySlot, type KeySlotRow, type SlotCredential } from "@/lib/vault/key-slot";
import { OAuthClients, type OAuthClientRecord } from "./clients";
import { OAuthContext } from "./context";
import { OAuthErrors, type OAuthProtocolError, type OAuthStorageError } from "./errors";
import { OAuthGrants, type GrantRevocationReason, type OAuthGrantRow } from "./grants";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";
import { McpScope } from "./scopes";
import { RequestThrottle } from "./throttle";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessToken,
  AUTHORIZATION_CODE_REPLAY_WINDOW_MS,
  AuthorizationCode,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  RefreshToken,
} from "./tokens";

type TokenError = OAuthProtocolError | OAuthStorageError;

const invalidGrant = (description: string) => OAuthErrors.protocol(400, "invalid_grant", description);
const invalidRequest = (description: string) => OAuthErrors.protocol(400, "invalid_request", description);

const codeVerifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;

const codePayloadSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scope: z.string(),
  resource: z.string().nullable(),
});

const s256 = (verifier: string): string =>
  Base64Url.encode(createHash("sha256").update(verifier, "ascii").digest());

/** Revokes the grant after a replayed credential, then reports invalid_grant either way. */
const revokeForReplay = async (
  ctx: OAuthContext,
  grantId: string | null,
  reason: GrantRevocationReason,
  description: string,
): Promise<Result<never, TokenError>> => {
  if (grantId !== null) {
    const revoked = await OAuthGrants.revoke(ctx.db, grantId, reason, ctx.vault.now());
    if (revoked.isErr()) return Result.err(revoked.error);
  }
  return Result.err(invalidGrant(description));
};

/** Loads the slot's grant and checks it is live, for this client and user. */
const liveGrant = async (
  ctx: OAuthContext,
  slot: KeySlotRow,
  client: OAuthClientRecord,
): Promise<Result<OAuthGrantRow, TokenError>> => {
  if (slot.grantId === null) return Result.err(invalidGrant("The grant is invalid."));
  const grant = await OAuthGrants.load(ctx.db, slot.grantId);
  if (grant.isErr()) return Result.err(grant.error);
  const row = grant.value;
  if (!row || row.revokedAt !== null) {
    return Result.err(invalidGrant("This authorization was revoked. Authorize the client again."));
  }
  if (row.clientId !== client.clientId) {
    return Result.err(invalidGrant("The grant was issued to a different client."));
  }
  if (row.userId !== slot.userId) return Result.err(invalidGrant("The grant is invalid."));
  return Result.ok(row);
};

type IssuedTokens = { readonly refreshToken: string; readonly accessToken: string; readonly scope: string };

/**
 * Marks `consumedSlotId` used (destroying its key share) and stores a new
 * refresh slot in one write transaction. Ok(null) when another request
 * consumed the slot first.
 */
const rotate = async (
  ctx: OAuthContext,
  consumedSlotId: string,
  grant: OAuthGrantRow,
  client: OAuthClientRecord,
  dek: Dek,
  scopes: readonly McpScope[],
): Promise<Result<IssuedTokens | null, OAuthStorageError>> => {
  const now = ctx.vault.now();
  const refresh = KeySlot.mint(ctx.vault, {
    userId: grant.userId,
    kind: "oauth_refresh",
    dek,
    grantId: grant.id,
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
  });
  const committed = await Result.tryPromise({
    try: () =>
      ctx.db.transaction(async (tx) => {
        const consumed = await tx
          .update(keySlot)
          .set({ consumedAt: now, lastUsedAt: now, wrappedDek: KeySlot.TOMBSTONE })
          .where(
            and(eq(keySlot.id, consumedSlotId), isNull(keySlot.consumedAt), isNull(keySlot.revokedAt)),
          )
          .returning({ id: keySlot.id });
        if (consumed.length !== 1) return false;
        await tx.insert(keySlot).values(refresh.values);
        return true;
      }),
    catch: (cause) => OAuthErrors.storage(`rotate key slot for grant ${grant.id}`, cause),
  });
  if (committed.isErr()) return Result.err(committed.error);
  if (!committed.value) return Result.ok(null);
  // Maintenance: the tokens are issued either way, so a failure is only logged.
  const swept = await KeySlot.destroyExpired(ctx.db, grant.userId, now);
  if (swept.isErr()) OAuthLog.failure(swept.error.operation, swept.error.cause);
  return Result.ok({
    refreshToken: RefreshToken.format(refresh.credential),
    accessToken: AccessToken.seal(ctx.vault.pepper, {
      userId: grant.userId,
      grantId: grant.id,
      clientId: client.clientId,
      scopes,
      exp: Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    }),
    scope: McpScope.format(scopes),
  });
};

/**
 * What a replay of a consumed credential means. `benign`: a client retry
 * (plain invalid_grant). `theft`: revoke the grant, but only when the
 * credential's own client replays it; anyone else holding an old credential
 * must not be able to disconnect the user. `stale`: too old to signal theft.
 */
type ReplayVerdict = "benign" | "theft" | "stale";

const openSlot = async (
  ctx: OAuthContext,
  client: OAuthClientRecord,
  credential: SlotCredential | undefined,
  kind: "oauth_code" | "oauth_refresh",
  replayReason: GrantRevocationReason,
  classifyReplay: (consumedAt: number) => ReplayVerdict,
): Promise<Result<{ row: KeySlotRow; dek: Dek }, TokenError>> => {
  const what = kind === "oauth_code" ? "authorization code" : "refresh token";
  if (!credential) return Result.err(invalidGrant(`The ${what} is invalid.`));
  const opened = await KeySlot.open(ctx.db, ctx.vault, { credential, kind });
  if (opened.isOk()) return Result.ok(opened.value);
  const error = opened.error;
  switch (error._tag) {
    case "VaultStorageError":
      return Result.err(OAuthErrors.storage(error.operation, error.cause));
    case "KeySlotInvalidError":
      return Result.err(
        invalidGrant(
          error.reason === "expired"
            ? `The ${what} has expired.`
            : error.reason === "revoked"
              ? `The ${what} was revoked. Authorize the client again.`
              : error.reason === "stale_key"
                ? `The ${what} is for an older pairing. Authorize the client again.`
                : `The ${what} is invalid.`,
        ),
      );
    case "KeySlotConsumedError": {
      const alreadyUsed = invalidGrant(
        kind === "oauth_code"
          ? "The authorization code was already used. Start the authorization again."
          : "The refresh token was already used. Use the newest one.",
      );
      if (classifyReplay(error.consumedAt) !== "theft" || error.grantId === null) return Result.err(alreadyUsed);
      const grant = await OAuthGrants.load(ctx.db, error.grantId);
      if (grant.isErr()) return Result.err(grant.error);
      if (grant.value === null || grant.value.clientId !== client.clientId) return Result.err(alreadyUsed);
      return revokeForReplay(
        ctx,
        error.grantId,
        replayReason,
        `The ${what} was already used, so this authorization was revoked to protect the account. Authorize the client again.`,
      );
    }
  }
};

const exchangeCode = async (
  ctx: OAuthContext,
  client: OAuthClientRecord,
  form: ReadonlyMap<string, string>,
): Promise<Result<IssuedTokens, TokenError>> => {
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const verifier = form.get("code_verifier");
  if (code === undefined) return Result.err(invalidRequest("code is required."));
  if (redirectUri === undefined) return Result.err(invalidRequest("redirect_uri is required."));
  if (verifier === undefined) return Result.err(invalidRequest("code_verifier is required (PKCE)."));

  const now = ctx.vault.now();
  const opened = await openSlot(
    ctx,
    client,
    AuthorizationCode.parse(code),
    "oauth_code",
    "authorization_code_reuse",
    (consumedAt) => (now - consumedAt <= AUTHORIZATION_CODE_REPLAY_WINDOW_MS ? "theft" : "stale"),
  );
  if (opened.isErr()) return Result.err(opened.error);
  const { row, dek } = opened.value;
  const payload = codePayloadSchema.safeParse(
    Result.try((): unknown => JSON.parse(row.payloadJson ?? "null")).unwrapOr(null),
  );
  if (!payload.success) return Result.err(invalidGrant("The authorization code is invalid."));
  const issued = payload.data;
  if (issued.clientId !== client.clientId) {
    return Result.err(invalidGrant("The authorization code was issued to a different client."));
  }
  if (issued.redirectUri !== redirectUri) {
    return Result.err(invalidGrant("redirect_uri does not match the authorization request."));
  }
  if (!codeVerifierPattern.test(verifier) || !KeySlot.constantTimeEqual(s256(verifier), issued.codeChallenge)) {
    return Result.err(invalidGrant("PKCE verification failed: code_verifier does not match code_challenge."));
  }
  const resource = form.get("resource");
  const mcpResource = OAuthContext.mcpResource(ctx);
  if (resource !== undefined && (resource !== mcpResource || (issued.resource !== null && issued.resource !== resource))) {
    return Result.err(OAuthErrors.protocol(400, "invalid_target", `resource must be ${mcpResource}.`));
  }
  const grant = await liveGrant(ctx, row, client);
  if (grant.isErr()) return Result.err(grant.error);

  const rotated = await rotate(ctx, row.id, grant.value, client, dek, McpScope.parse(issued.scope).scopes);
  if (rotated.isErr()) return Result.err(rotated.error);
  if (rotated.value === null) {
    // Another request redeemed this code between our read and write.
    return revokeForReplay(
      ctx,
      grant.value.id,
      "authorization_code_reuse",
      "The authorization code was already used, so this authorization was revoked. Authorize the client again.",
    );
  }
  return Result.ok(rotated.value);
};

const refresh = async (
  ctx: OAuthContext,
  client: OAuthClientRecord,
  form: ReadonlyMap<string, string>,
): Promise<Result<IssuedTokens, TokenError>> => {
  const token = form.get("refresh_token");
  if (token === undefined) return Result.err(invalidRequest("refresh_token is required."));
  const now = ctx.vault.now();
  const opened = await openSlot(
    ctx,
    client,
    RefreshToken.parse(token),
    "oauth_refresh",
    "refresh_token_reuse",
    (consumedAt) => (now - consumedAt <= REFRESH_REUSE_GRACE_MS ? "benign" : "theft"),
  );
  if (opened.isErr()) return Result.err(opened.error);
  const { row, dek } = opened.value;
  const grant = await liveGrant(ctx, row, client);
  if (grant.isErr()) return Result.err(grant.error);

  const granted = McpScope.parse(grant.value.scope).scopes;
  const scopeParam = form.get("scope");
  let scopes = granted;
  if (scopeParam !== undefined) {
    const requested = McpScope.parse(scopeParam);
    if (requested.unknown.length > 0 || requested.scopes.length === 0 || !McpScope.includesAll(granted, requested.scopes)) {
      return Result.err(
        OAuthErrors.protocol(400, "invalid_scope", `scope may only narrow the granted scopes (${McpScope.format(granted)}).`),
      );
    }
    scopes = requested.scopes;
  }

  const rotated = await rotate(ctx, row.id, grant.value, client, dek, scopes);
  if (rotated.isErr()) return Result.err(rotated.error);
  if (rotated.value === null) {
    // A concurrent refresh with the same token won; treat as a retry inside the grace window.
    return Result.err(invalidGrant("The refresh token was already used. Use the newest one."));
  }
  return Result.ok(rotated.value);
};

const throttled = (retryAfterSeconds: number) =>
  OAuthHttp.protocolError(OAuthClients.tooManyRequests(retryAfterSeconds));

/** POST /oauth/token (RFC 6749 section 3.2 with PKCE, RFC 8707 and refresh rotation). */
const handle = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  const ipLimit = await RequestThrottle.hit(
    ctx.db,
    `token:ip:${OAuthHttp.clientIp(request)}`,
    RequestThrottle.rules.tokenPerIp,
    ctx.vault.now(),
  );
  if (ipLimit.isErr()) return OAuthClients.logStorageError(ipLimit.error);
  if (!ipLimit.value.allowed) return throttled(ipLimit.value.retryAfterSeconds);

  const form = await OAuthHttp.readForm(request);
  if (form.isErr()) return OAuthHttp.protocolError(form.error);
  const client = await OAuthClients.authenticate(ctx.db, request, form.value);
  if (client.isErr()) {
    return client.error._tag === "OAuthStorageError"
      ? OAuthClients.logStorageError(client.error)
      : OAuthHttp.protocolError(client.error);
  }
  // Keyed by client AND address: client_ids are public, so a per-client
  // bucket alone would let anyone block a client's real users.
  const clientLimit = await RequestThrottle.hit(
    ctx.db,
    `token:client:${client.value.clientId}:${OAuthHttp.clientIp(request)}`,
    RequestThrottle.rules.tokenPerClient,
    ctx.vault.now(),
  );
  if (clientLimit.isErr()) return OAuthClients.logStorageError(clientLimit.error);
  if (!clientLimit.value.allowed) return throttled(clientLimit.value.retryAfterSeconds);

  const grantType = form.value.get("grant_type");
  const result =
    grantType === "authorization_code"
      ? await exchangeCode(ctx, client.value, form.value)
      : grantType === "refresh_token"
        ? await refresh(ctx, client.value, form.value)
        : Result.err(
            grantType === undefined
              ? invalidRequest("grant_type is required.")
              : OAuthErrors.protocol(400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token."),
          );
  if (result.isErr()) {
    return result.error._tag === "OAuthStorageError"
      ? OAuthClients.logStorageError(result.error)
      : OAuthHttp.protocolError(result.error);
  }
  return OAuthHttp.json({
    access_token: result.value.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: result.value.refreshToken,
    scope: result.value.scope,
  });
};

export const TokenEndpoint = { handle } as const;

import { Result } from "better-result";
import { KeySlot } from "@/lib/vault/key-slot";
import { OAuthClients, type OAuthClientRecord } from "./clients";
import type { OAuthContext } from "./context";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { OAuthGrants } from "./grants";
import { OAuthHttp } from "./http";
import { AccessToken, RefreshToken } from "./tokens";

/** The grant a presented token belongs to, if the token is genuine (state is irrelevant for revocation). */
const grantOfToken = async (
  ctx: OAuthContext,
  token: string,
): Promise<Result<string | null, OAuthStorageError>> => {
  const refresh = RefreshToken.parse(token);
  if (refresh) {
    const loaded = await KeySlot.load(ctx.db, refresh.slotId);
    if (loaded.isErr()) return Result.err(OAuthErrors.storage(loaded.error.operation, loaded.error.cause));
    const row = loaded.value;
    if (!row || row.kind !== "oauth_refresh" || row.grantId === null) return Result.ok(null);
    if (!KeySlot.constantTimeEqual(KeySlot.verifierFor(ctx.vault.pepper, refresh), row.verifier)) {
      return Result.ok(null);
    }
    return Result.ok(row.grantId);
  }
  const access = AccessToken.open(ctx.vault.pepper, token);
  if (access.isOk()) return Result.ok(access.value.grantId);
  return Result.ok(null);
};

const ok = () => new Response(null, { status: 200, headers: { ...OAuthHttp.corsHeaders, "Cache-Control": "no-store" } });

/**
 * POST /oauth/revoke (RFC 7009). Revoking a refresh or access token revokes
 * its whole grant (all refresh tokens and, via the per-request grant check,
 * all access tokens). Unknown or invalid tokens still get 200. Clients that
 * identify themselves must authenticate and may only revoke their own grants.
 */
const handle = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  const form = await OAuthHttp.readForm(request);
  if (form.isErr()) return OAuthHttp.protocolError(form.error);
  const token = form.value.get("token");
  if (token === undefined) {
    return OAuthHttp.protocolError(OAuthErrors.protocol(400, "invalid_request", "token is required."));
  }
  let client: OAuthClientRecord | null = null;
  if (OAuthClients.presentsCredentials(request, form.value)) {
    const authenticated = await OAuthClients.authenticate(ctx.db, request, form.value);
    if (authenticated.isErr()) {
      return authenticated.error._tag === "OAuthStorageError"
        ? OAuthClients.logStorageError(authenticated.error)
        : OAuthHttp.protocolError(authenticated.error);
    }
    client = authenticated.value;
  }
  const target = await grantOfToken(ctx, token);
  if (target.isErr()) return OAuthClients.logStorageError(target.error);
  if (!target.value) return ok();

  const grant = await OAuthGrants.load(ctx.db, target.value);
  if (grant.isErr()) return OAuthClients.logStorageError(grant.error);
  if (!grant.value || (client !== null && grant.value.clientId !== client.clientId)) return ok();

  const revoked = await OAuthGrants.revoke(ctx.db, grant.value.id, "revoked_by_client", ctx.vault.now());
  if (revoked.isErr()) return OAuthClients.logStorageError(revoked.error);
  return ok();
};

export const RevokeEndpoint = { handle } as const;

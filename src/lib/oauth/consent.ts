import { randomBytes } from "node:crypto";
import { Result } from "better-result";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { Base64Url } from "@/lib/vault/base64url";
import type { Dek } from "@/lib/vault/dek";
import { KeySlot } from "@/lib/vault/key-slot";
import { PairingKeys } from "@/lib/vault/pairing-keys";
import { AuthorizationRequest, type ValidatedAuthorization } from "./authorization-request";
import { AuthorizeEndpoint } from "./authorize";
import { ConsentTicket } from "./consent-ticket";
import type { BrowserSession, OAuthContext } from "./context";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";
import { McpScope } from "./scopes";
import { AUTHORIZATION_CODE_TTL_MS, AuthorizationCode } from "./tokens";

/** What the consent page renders. */
export type ConsentView =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "sign_in"; readonly signInUrl: string }
  | { readonly kind: "locked"; readonly clientName: string; readonly message: string }
  | {
      readonly kind: "ready";
      readonly clientName: string;
      readonly redirectHost: string;
      readonly scopes: readonly McpScope[];
      readonly ticket: string;
      /** True when approving creates this browser's vault key (the user has not paired yet). */
      readonly createsKey: boolean;
    };

export const LOCKED_MESSAGE =
  "This browser cannot unlock your account, so it cannot approve MCP clients. Approve from the browser you paired your phone with, or re-pair your phone here (that replaces your key and disconnects existing MCP clients).";

const UNAVAILABLE_MESSAGE =
  "openrcs could not load this request right now. Nothing was shared. Reload the page to try again.";

/** Host (or scheme for custom-scheme apps) the user will be sent back to. */
const redirectHostOf = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.host !== "" ? url.host : url.protocol;
};

const cookieHeaderOf = (headers: Headers) => headers.get("cookie");

/** Loads the consent page state for the authorization request in `params`. */
const load = async (ctx: OAuthContext, params: URLSearchParams, headers: Headers): Promise<ConsentView> => {
  const validated = await AuthorizationRequest.validate(ctx, params);
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return { kind: "invalid", message: error.message };
      case "AuthorizeRedirectError":
        return {
          kind: "invalid",
          message: `This authorization request is invalid: ${error.description} Nothing was shared. Return to the app you were connecting and start again.`,
        };
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
    }
  }
  const { request, client } = validated.value;
  const session = await AuthorizeEndpoint.sessionOf(ctx, headers);
  if (session.isErr()) return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  if (session.value === null) {
    const authorize = `/oauth/authorize?${AuthorizationRequest.toSearchParams(request).toString()}`;
    return { kind: "sign_in", signInUrl: AuthorizeEndpoint.signInUrl(authorize) };
  }
  const prepared = await PairingKeys.prepareWith(
    ctx.db,
    ctx.vault,
    session.value.userId,
    cookieHeaderOf(headers),
    { mode: "consent" },
  );
  if (prepared.isErr()) {
    if (prepared.error._tag === "VaultLockedError") {
      return { kind: "locked", clientName: client.clientName, message: LOCKED_MESSAGE };
    }
    OAuthLog.failure(prepared.error.operation, prepared.error.cause);
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }
  return {
    kind: "ready",
    clientName: client.clientName,
    redirectHost: redirectHostOf(request.redirectUri),
    scopes: request.scopes,
    ticket: ConsentTicket.issue(ctx, session.value, request),
    createsKey: prepared.value.isNewKey,
  };
};

/** Creates the grant and a 60 s single-use oauth_code slot; returns the code string. */
const issueCode = async (
  ctx: OAuthContext,
  session: BrowserSession,
  authorization: ValidatedAuthorization,
  dek: Dek,
): Promise<Result<string, OAuthStorageError>> => {
  const now = ctx.vault.now();
  const { request } = authorization;
  const grantId = Base64Url.encode(randomBytes(16));
  const code = KeySlot.mint(ctx.vault, {
    userId: session.userId,
    kind: "oauth_code",
    dek,
    grantId,
    expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
    payloadJson: JSON.stringify({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: McpScope.format(request.scopes),
      resource: request.resource,
    }),
  });
  const stored = await Result.tryPromise({
    try: () =>
      ctx.db.batch([
        ctx.db.insert(oauthGrant).values({
          id: grantId,
          userId: session.userId,
          clientId: request.clientId,
          scope: McpScope.format(request.scopes),
          dekId: dek.id,
          createdAt: now,
        }),
        ctx.db.insert(keySlot).values(code.values),
      ]),
    catch: (cause) => OAuthErrors.storage(`create grant and authorization code for client ${request.clientId}`, cause),
  });
  if (stored.isErr()) return Result.err(stored.error);
  return Result.ok(AuthorizationCode.format(code.credential));
};

const page = (status: number, title: string, message: string, setCookie?: string): Response => {
  const response = OAuthHttp.htmlError(status, title, message);
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
};

/**
 * POST /oauth/consent/decision (form: ticket, decision=approve|deny).
 * CSRF: the Origin must be ours and the ticket must be valid, unexpired,
 * unused and bound to the current Better Auth session.
 */
const decide = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  if (request.headers.get("origin") !== ctx.origin) {
    return page(403, "Request blocked", "This approval did not come from the openrcs consent page. Nothing was shared.");
  }
  const form = await OAuthHttp.readForm(request);
  if (form.isErr()) return page(400, "Cannot process approval", `${form.error.description} Nothing was shared.`);
  const ticket = form.value.get("ticket");
  const decision = form.value.get("decision");
  if (ticket === undefined || (decision !== "approve" && decision !== "deny")) {
    return page(400, "Cannot process approval", "The approval form is incomplete. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const session = await AuthorizeEndpoint.sessionOf(ctx, request.headers);
  if (session.isErr()) return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  if (session.value === null) {
    return page(401, "Signed out", "Your openrcs session ended before you approved. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const claims = ConsentTicket.verify(ctx, ticket, session.value);
  if (claims.isErr()) return page(400, "Approval expired", claims.error.message);
  const consumed = await ConsentTicket.consume(ctx, claims.value);
  if (consumed.isErr()) {
    if (consumed.error._tag === "OAuthStorageError") {
      OAuthLog.failure(consumed.error.operation, consumed.error.cause);
      return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
    return page(400, "Approval already used", consumed.error.message);
  }

  // Re-check against the current registration (the client may have changed since the page loaded).
  const validated = await AuthorizationRequest.validate(ctx, AuthorizationRequest.toSearchParams(claims.value.request));
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return page(400, "Cannot authorize this app", error.message);
      case "AuthorizeRedirectError":
        return OAuthHttp.seeOther(AuthorizationRequest.errorUrl(ctx, error));
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
  }
  const authorization = validated.value;
  const { request: authRequest } = authorization;

  if (decision === "deny") {
    return OAuthHttp.seeOther(
      AuthorizationRequest.responseUrl(ctx, authRequest.redirectUri, {
        error: "access_denied",
        error_description: "The user denied access.",
        state: authRequest.state,
      }),
    );
  }

  const prepared = await PairingKeys.prepareWith(
    ctx.db,
    ctx.vault,
    session.value.userId,
    cookieHeaderOf(request.headers),
    { mode: "consent" },
  );
  if (prepared.isErr()) {
    if (prepared.error._tag === "VaultLockedError") {
      // The consent page explains the lock and how to fix it.
      return OAuthHttp.seeOther(`/oauth/consent?${AuthorizationRequest.toSearchParams(authRequest).toString()}`);
    }
    OAuthLog.failure(prepared.error.operation, prepared.error.cause);
    return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  }
  // No gm_session exists when consent mints a key (prepare refuses otherwise), so there is no old data to delete.
  const committed = await PairingKeys.commitWith(ctx.db, ctx.vault, prepared.value, {
    onKeyRotated: async () => {},
  });
  if (committed.isErr()) {
    OAuthLog.failure(committed.error.operation, committed.error.cause);
    return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  }
  const setCookie = prepared.value.setCookie ?? undefined;
  const code = await issueCode(ctx, session.value, authorization, prepared.value.dek);
  if (code.isErr()) {
    OAuthLog.failure(code.error.operation, code.error.cause);
    // The device slot (if new) is stored, so the browser still gets its cookie.
    return page(503, "Authorization unavailable", UNAVAILABLE_MESSAGE, setCookie);
  }
  return OAuthHttp.seeOther(
    AuthorizationRequest.responseUrl(ctx, authRequest.redirectUri, {
      code: code.value,
      state: authRequest.state,
    }),
    setCookie ? { "Set-Cookie": setCookie } : {},
  );
};

export const ConsentFlow = { load, decide, redirectHostOf } as const;

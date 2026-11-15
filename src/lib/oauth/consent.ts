import { randomBytes } from "node:crypto";
import { Result } from "better-result";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { Base64Url } from "@/lib/vault/base64url";
import { KeySlot } from "@/lib/vault/key-slot";
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
  | {
      readonly kind: "ready";
      readonly clientName: string;
      readonly redirectHost: string;
      readonly scopes: readonly McpScope[];
      readonly ticket: string;
    };

const UNAVAILABLE_MESSAGE =
  "openrcs could not load this request right now. Nothing was shared. Reload the page to try again.";

/** Host (or scheme for custom-scheme apps) the user will be sent back to. */
const redirectHostOf = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.host !== "" ? url.host : url.protocol;
};

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
  return {
    kind: "ready",
    clientName: client.clientName,
    redirectHost: redirectHostOf(request.redirectUri),
    scopes: request.scopes,
    ticket: ConsentTicket.issue(ctx, session.value, request),
  };
};

/** Creates the grant and a 60 s single-use oauth_code slot; returns the code string. */
const issueCode = async (
  ctx: OAuthContext,
  session: BrowserSession,
  authorization: ValidatedAuthorization,
): Promise<Result<string, OAuthStorageError>> => {
  const now = ctx.vault.now();
  const { request } = authorization;
  const grantId = Base64Url.encode(randomBytes(16));
  const code = KeySlot.mint(ctx.vault, {
    userId: session.userId,
    kind: "oauth_code",
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
          createdAt: now,
        }),
        ctx.db.insert(keySlot).values(code.values),
      ]),
    catch: (cause) => OAuthErrors.storage(`create grant and authorization code for client ${request.clientId}`, cause),
  });
  if (stored.isErr()) return Result.err(stored.error);
  return Result.ok(AuthorizationCode.format(code.credential));
};

/**
 * POST /oauth/consent/decision (form: ticket, decision=approve|deny).
 * CSRF: the Origin must be ours and the ticket must be valid, unexpired,
 * unused and bound to the current Better Auth session.
 */
const decide = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  if (request.headers.get("origin") !== ctx.origin) {
    return OAuthHttp.htmlError(403, "Request blocked", "This approval did not come from the openrcs consent page. Nothing was shared.");
  }
  const form = await OAuthHttp.readForm(request);
  if (form.isErr()) return OAuthHttp.htmlError(400, "Cannot process approval", `${form.error.description} Nothing was shared.`);
  const ticket = form.value.get("ticket");
  const decision = form.value.get("decision");
  if (ticket === undefined || (decision !== "approve" && decision !== "deny")) {
    return OAuthHttp.htmlError(400, "Cannot process approval", "The approval form is incomplete. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const session = await AuthorizeEndpoint.sessionOf(ctx, request.headers);
  if (session.isErr()) return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  if (session.value === null) {
    return OAuthHttp.htmlError(401, "Signed out", "Your openrcs session ended before you approved. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const claims = ConsentTicket.verify(ctx, ticket, session.value);
  if (claims.isErr()) return OAuthHttp.htmlError(400, "Approval expired", claims.error.message);
  const consumed = await ConsentTicket.consume(ctx, claims.value);
  if (consumed.isErr()) {
    if (consumed.error._tag === "OAuthStorageError") {
      OAuthLog.failure(consumed.error.operation, consumed.error.cause);
      return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
    return OAuthHttp.htmlError(400, "Approval already used", consumed.error.message);
  }

  // Re-check against the current registration (the client may have changed since the page loaded).
  const validated = await AuthorizationRequest.validate(ctx, AuthorizationRequest.toSearchParams(claims.value.request));
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return OAuthHttp.htmlError(400, "Cannot authorize this app", error.message);
      case "AuthorizeRedirectError":
        return OAuthHttp.seeOther(AuthorizationRequest.errorUrl(ctx, error));
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
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

  const code = await issueCode(ctx, session.value, authorization);
  if (code.isErr()) {
    OAuthLog.failure(code.error.operation, code.error.cause);
    return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  }
  return OAuthHttp.seeOther(
    AuthorizationRequest.responseUrl(ctx, authRequest.redirectUri, {
      code: code.value,
      state: authRequest.state,
    }),
  );
};

export const ConsentFlow = { load, decide, redirectHostOf } as const;

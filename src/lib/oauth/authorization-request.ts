import { Result, TaggedError } from "better-result";
import { OAuthClients, type OAuthClientRecord } from "./clients";
import { OAuthContext } from "./context";
import type { OAuthStorageError } from "./errors";
import { McpScope } from "./scopes";

/** A validated authorization request (RFC 6749 4.1.1 + PKCE + RFC 8707). */
export type AuthorizationRequest = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly McpScope[];
  readonly state: string | null;
  readonly codeChallenge: string;
  /** The RFC 8707 resource the client asked for (always the MCP resource), or null. */
  readonly resource: string | null;
};

export type ValidatedAuthorization = {
  readonly request: AuthorizationRequest;
  readonly client: OAuthClientRecord;
};

/**
 * The client or redirect URI cannot be trusted, so the user sees an error page
 * and is never redirected (RFC 6749 section 4.1.2.1).
 */
export class AuthorizeFatalError extends TaggedError("AuthorizeFatalError")<{
  message: string;
}> {}

/** An error the client should receive on its (verified) redirect URI. */
export class AuthorizeRedirectError extends TaggedError("AuthorizeRedirectError")<{
  redirectUri: string;
  state: string | null;
  error: string;
  description: string;
  message: string;
}> {}

const MAX_STATE_LENGTH = 2048;
/** S256 challenges are base64url SHA-256 digests: exactly 43 characters. */
const s256ChallengePattern = /^[A-Za-z0-9_-]{43}$/;

const fatal = (message: string) => Result.err(new AuthorizeFatalError({ message }));

const restart = "Nothing was shared. Return to the app you were connecting and start again.";

/**
 * Validates client and redirect URI first (failures never redirect), then
 * everything else (failures go back to the client as error redirects).
 */
const validate = async (
  ctx: OAuthContext,
  params: URLSearchParams,
): Promise<
  Result<ValidatedAuthorization, AuthorizeFatalError | AuthorizeRedirectError | OAuthStorageError>
> => {
  const clientIds = params.getAll("client_id");
  const redirectUris = params.getAll("redirect_uri");
  if (clientIds.length !== 1 || clientIds[0] === "") {
    return fatal(`This authorization request does not name exactly one client (client_id). ${restart}`);
  }
  const found = await OAuthClients.find(ctx.db, clientIds[0]);
  if (found.isErr()) return Result.err(found.error);
  const client = found.value;
  if (!client) {
    return fatal(`The app requesting access is not registered here (unknown client_id). ${restart}`);
  }
  if (redirectUris.length !== 1) {
    return fatal(`This authorization request must include exactly one redirect_uri. ${restart}`);
  }
  const redirectUri = redirectUris[0];
  if (!client.redirectUris.includes(redirectUri)) {
    return fatal(
      `The redirect_uri does not exactly match any redirect URI registered by this app, so openrcs will not send you there. ${restart}`,
    );
  }

  const rawState = params.getAll("state");
  const state = rawState.length === 1 && rawState[0] !== "" ? rawState[0] : null;
  const fail = (error: string, description: string) =>
    Result.err(
      new AuthorizeRedirectError({
        redirectUri,
        state: state !== null && state.length <= MAX_STATE_LENGTH ? state : null,
        error,
        description,
        message: `Authorization request rejected (${error}): ${description}`,
      }),
    );

  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length > 1) return fail("invalid_request", `The "${key}" parameter must not be repeated.`);
  }
  if (state !== null && state.length > MAX_STATE_LENGTH) {
    return fail("invalid_request", `state must be at most ${MAX_STATE_LENGTH} characters.`);
  }
  const responseType = params.get("response_type");
  if (responseType === null || responseType === "") {
    return fail("invalid_request", "response_type is required (use code).");
  }
  if (responseType !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  }
  const codeChallenge = params.get("code_challenge");
  if (codeChallenge === null || codeChallenge === "") {
    return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256 (plain is not supported).");
  }
  if (!s256ChallengePattern.test(codeChallenge)) {
    return fail("invalid_request", "code_challenge must be the 43-character base64url SHA-256 of the code verifier.");
  }
  const resource = params.get("resource");
  const mcpResource = OAuthContext.mcpResource(ctx);
  if (resource !== null && resource !== mcpResource) {
    return fail("invalid_target", `resource must be ${mcpResource}.`);
  }
  const scopeParam = params.get("scope");
  const requested = scopeParam === null || scopeParam.trim() === ""
    ? client.scopes
    : McpScope.parse(scopeParam).scopes;
  const scopes = McpScope.intersect(requested, client.scopes);
  if (scopes.length === 0) {
    return fail(
      "invalid_scope",
      `None of the requested scopes are available to this client; supported: ${McpScope.format(client.scopes)}.`,
    );
  }

  return Result.ok({
    client,
    request: { clientId: client.clientId, redirectUri, scopes, state, codeChallenge, resource },
  });
};

/** Canonical query string for a validated request (used for the consent page URL). */
const toSearchParams = (request: AuthorizationRequest): URLSearchParams => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: McpScope.format(request.scopes),
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  });
  if (request.state !== null) params.set("state", request.state);
  if (request.resource !== null) params.set("resource", request.resource);
  return params;
};

/** `redirectUri` with response parameters appended, always including `iss` (RFC 9207). */
const responseUrl = (
  ctx: Pick<OAuthContext, "origin">,
  redirectUri: string,
  params: Readonly<Record<string, string | null>>,
): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", ctx.origin);
  return url.toString();
};

const errorUrl = (ctx: Pick<OAuthContext, "origin">, error: AuthorizeRedirectError): string =>
  responseUrl(ctx, error.redirectUri, {
    error: error.error,
    error_description: error.description,
    state: error.state,
  });

export const AuthorizationRequest = {
  validate,
  toSearchParams,
  responseUrl,
  errorUrl,
} as const;

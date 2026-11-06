import { createHash, randomBytes } from "node:crypto";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db/client";
import {
  OAUTH_CLIENT_AUTH_METHODS,
  oauthClient,
  type OAuthClientAuthMethod,
} from "@/lib/db/vault-schema";
import { Base64Url } from "@/lib/vault/base64url";
import { KeySlot } from "@/lib/vault/key-slot";
import type { OAuthContext } from "./context";
import { OAuthErrors, type OAuthProtocolError, type OAuthStorageError } from "./errors";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";
import { RedirectUri } from "./redirect-uri";
import { McpScope } from "./scopes";
import { RequestThrottle } from "./throttle";

export const DEFAULT_CLIENT_NAME = "MCP client";
export const MAX_CLIENT_NAME_LENGTH = 200;
export const MAX_REDIRECT_URIS = 10;

/** A registered client as the server uses it. */
export type OAuthClientRecord = {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: OAuthClientAuthMethod;
  readonly clientSecretHash: string | null;
  readonly scopes: readonly McpScope[];
};

/** Validated RFC 7591 registration request. */
export type ClientRegistration = {
  readonly redirectUris: readonly string[];
  readonly clientName: string;
  readonly tokenEndpointAuthMethod: OAuthClientAuthMethod;
  readonly scopes: readonly McpScope[];
  readonly clientUri: string | null;
  readonly logoUri: string | null;
};

const invalidMetadata = (description: string) =>
  OAuthErrors.protocol(400, "invalid_client_metadata", description);

const isAuthMethod = (value: unknown): value is OAuthClientAuthMethod =>
  OAUTH_CLIENT_AUTH_METHODS.some((method) => method === value);

const optionalStringArray = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  allowed: readonly string[],
  required: string | null,
): Result<void, OAuthProtocolError> => {
  const value = body[field];
  if (value === undefined || value === null) return Result.ok();
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return Result.err(invalidMetadata(`${field} must be an array of strings.`));
  }
  const unsupported = value.filter((item) => !allowed.includes(item));
  if (unsupported.length > 0) {
    return Result.err(
      invalidMetadata(`${field} contains unsupported values (${unsupported.join(", ")}); supported: ${allowed.join(", ")}.`),
    );
  }
  if (required !== null && !value.includes(required)) {
    return Result.err(invalidMetadata(`${field} must include ${required}.`));
  }
  return Result.ok();
};

const optionalWebUri = (
  body: Readonly<Record<string, unknown>>,
  field: string,
): Result<string | null, OAuthProtocolError> => {
  const value = body[field];
  if (value === undefined || value === null) return Result.ok(null);
  return RedirectUri.validateWebUri(value).mapError((error) =>
    invalidMetadata(`${field} is invalid: ${error.reason}.`),
  );
};

/** Validates an RFC 7591 client metadata document. Pure; used by the register endpoint. */
const parseRegistration = (
  body: Readonly<Record<string, unknown>>,
): Result<ClientRegistration, OAuthProtocolError> => {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return Result.err(
      OAuthErrors.protocol(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array."),
    );
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return Result.err(
      OAuthErrors.protocol(
        400,
        "invalid_redirect_uri",
        `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`,
      ),
    );
  }
  const redirectUris: string[] = [];
  for (const [index, uri] of uris.entries()) {
    const validated = RedirectUri.validate(uri);
    if (validated.isErr()) {
      return Result.err(
        OAuthErrors.protocol(
          400,
          "invalid_redirect_uri",
          `redirect_uris[${index}] is invalid: ${validated.error.reason}.`,
        ),
      );
    }
    redirectUris.push(validated.value);
  }

  const rawName = body.client_name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
    return Result.err(invalidMetadata("client_name must be a string."));
  }
  const clientName = typeof rawName === "string" && rawName.trim() !== "" ? rawName : DEFAULT_CLIENT_NAME;
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return Result.err(
      invalidMetadata(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters.`),
    );
  }

  const rawMethod = body.token_endpoint_auth_method ?? "none";
  if (!isAuthMethod(rawMethod)) {
    return Result.err(
      invalidMetadata(
        `token_endpoint_auth_method must be one of ${OAUTH_CLIENT_AUTH_METHODS.join(", ")}.`,
      ),
    );
  }

  const grantTypes = optionalStringArray(
    body,
    "grant_types",
    ["authorization_code", "refresh_token"],
    "authorization_code",
  );
  if (grantTypes.isErr()) return Result.err(grantTypes.error);
  const responseTypes = optionalStringArray(body, "response_types", ["code"], null);
  if (responseTypes.isErr()) return Result.err(responseTypes.error);

  const rawScope = body.scope;
  if (rawScope !== undefined && rawScope !== null && typeof rawScope !== "string") {
    return Result.err(invalidMetadata("scope must be a space-separated string."));
  }
  // Unknown scopes (e.g. "openid") are ignored; a client asking for none of ours gets both.
  const requested = typeof rawScope === "string" ? McpScope.parse(rawScope).scopes : [];
  const scopes = requested.length > 0 ? requested : McpScope.all;

  const clientUri = optionalWebUri(body, "client_uri");
  if (clientUri.isErr()) return Result.err(clientUri.error);
  const logoUri = optionalWebUri(body, "logo_uri");
  if (logoUri.isErr()) return Result.err(logoUri.error);

  return Result.ok({
    redirectUris,
    clientName,
    tokenEndpointAuthMethod: rawMethod,
    scopes,
    clientUri: clientUri.value,
    logoUri: logoUri.value,
  });
};

const hashSecret = (secret: string): string =>
  Base64Url.encode(createHash("sha256").update(secret, "utf8").digest());

const tooManyRequests = (retryAfterSeconds: number) =>
  OAuthErrors.protocol(
    429,
    "slow_down",
    `Too many requests. Nothing was registered or issued; retry after ${retryAfterSeconds} seconds.`,
    { "Retry-After": String(retryAfterSeconds) },
  );

const logStorageError = (error: OAuthStorageError): Response => {
  OAuthLog.failure(error.operation, error.cause);
  return OAuthHttp.json(
    {
      error: "server_error",
      error_description:
        "The server could not complete the request. Nothing was registered or issued; retry shortly.",
    },
    { status: 500 },
  );
};

/** POST /oauth/register (RFC 7591). */
const register = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  const now = ctx.vault.now();
  const throttled = await RequestThrottle.hit(
    ctx.db,
    `register:ip:${OAuthHttp.clientIp(request)}`,
    RequestThrottle.rules.registerPerIp,
    now,
  );
  if (throttled.isErr()) return logStorageError(throttled.error);
  if (!throttled.value.allowed) {
    return OAuthHttp.protocolError(tooManyRequests(throttled.value.retryAfterSeconds));
  }

  const body = await OAuthHttp.readJsonObject(request);
  if (body.isErr()) return OAuthHttp.protocolError(body.error);
  const parsed = parseRegistration(body.value);
  if (parsed.isErr()) return OAuthHttp.protocolError(parsed.error);
  const registration = parsed.value;

  const clientId = Base64Url.encode(randomBytes(18));
  const clientSecret =
    registration.tokenEndpointAuthMethod === "none"
      ? null
      : `ocs_${Base64Url.encode(randomBytes(32))}`;
  const scope = McpScope.format(registration.scopes);

  const inserted = await Result.tryPromise({
    try: () =>
      ctx.db.insert(oauthClient).values({
        clientId,
        clientSecretHash: clientSecret === null ? null : hashSecret(clientSecret),
        clientName: registration.clientName,
        redirectUrisJson: JSON.stringify(registration.redirectUris),
        tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
        scope,
        clientUri: registration.clientUri,
        logoUri: registration.logoUri,
        createdAt: now,
      }),
    catch: (cause) => OAuthErrors.storage("register client", cause),
  });
  if (inserted.isErr()) return logStorageError(inserted.error);

  return OAuthHttp.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret === null ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: registration.tokenEndpointAuthMethod,
      scope,
      ...(registration.clientUri === null ? {} : { client_uri: registration.clientUri }),
      ...(registration.logoUri === null ? {} : { logo_uri: registration.logoUri }),
    },
    { status: 201 },
  );
};

const redirectUrisSchema = z.array(z.string());

const find = async (
  db: Database,
  clientId: string,
): Promise<Result<OAuthClientRecord | null, OAuthStorageError>> => {
  const loaded = await Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select()
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId))
        .limit(1);
      return row ?? null;
    },
    catch: (cause) => OAuthErrors.storage(`load client ${clientId}`, cause),
  });
  if (loaded.isErr()) return Result.err(loaded.error);
  const row = loaded.value;
  if (!row) return Result.ok(null);
  const uris = Result.try({
    try: () => redirectUrisSchema.parse(JSON.parse(row.redirectUrisJson)),
    catch: (cause) => OAuthErrors.storage(`parse redirect_uris_json of client ${clientId}`, cause),
  });
  if (uris.isErr()) return Result.err(uris.error);
  return Result.ok({
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: uris.value,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    clientSecretHash: row.clientSecretHash,
    scopes: McpScope.parse(row.scope).scopes,
  });
};

type PresentedCredentials =
  | { readonly method: "client_secret_basic"; readonly clientId: string; readonly secret: string }
  | { readonly method: "client_secret_post"; readonly clientId: string; readonly secret: string }
  | { readonly method: "none"; readonly clientId: string };

const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="openrcs"' };

const invalidClient = (description: string, basic: boolean) =>
  OAuthErrors.protocol(401, "invalid_client", description, basic ? BASIC_CHALLENGE : undefined);

const decodeFormComponent = (value: string): string | undefined =>
  Result.try(() => decodeURIComponent(value.replace(/\+/g, " "))).unwrapOr(undefined);

/** Which client authentication the request presents, if any (RFC 6749 section 2.3). */
const presentedCredentials = (
  request: Request,
  form: ReadonlyMap<string, string>,
): Result<PresentedCredentials | null, OAuthProtocolError> => {
  const authorization = request.headers.get("authorization");
  const bodyClientId = form.get("client_id");
  if (authorization !== null && /^basic /i.test(authorization)) {
    const decoded = Result.try(() =>
      Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8"),
    ).unwrapOr("");
    const separator = decoded.indexOf(":");
    const clientId = separator > 0 ? decodeFormComponent(decoded.slice(0, separator)) : undefined;
    const secret = separator > 0 ? decodeFormComponent(decoded.slice(separator + 1)) : undefined;
    if (clientId === undefined || secret === undefined || secret === "") {
      return Result.err(invalidClient("The Basic authorization header is malformed.", true));
    }
    if (form.has("client_secret")) {
      return Result.err(invalidClient("Use only one client authentication method.", true));
    }
    if (bodyClientId !== undefined && bodyClientId !== clientId) {
      return Result.err(
        OAuthErrors.protocol(400, "invalid_request", "client_id does not match the Basic credentials."),
      );
    }
    return Result.ok({ method: "client_secret_basic", clientId, secret });
  }
  if (bodyClientId === undefined) return Result.ok(null);
  const secret = form.get("client_secret");
  return Result.ok(
    secret === undefined
      ? { method: "none", clientId: bodyClientId }
      : { method: "client_secret_post", clientId: bodyClientId, secret },
  );
};

/**
 * Authenticates the client of a token or revocation request with its
 * registered method. Secrets are compared as SHA-256 hashes in constant time.
 */
const authenticate = async (
  db: Database,
  request: Request,
  form: ReadonlyMap<string, string>,
): Promise<Result<OAuthClientRecord, OAuthProtocolError | OAuthStorageError>> => {
  const presented = presentedCredentials(request, form);
  if (presented.isErr()) return Result.err(presented.error);
  const credentials = presented.value;
  if (credentials === null) {
    return Result.err(invalidClient("client_id is required (or client credentials in a Basic header).", false));
  }
  const basic = credentials.method === "client_secret_basic";
  const found = await find(db, credentials.clientId);
  if (found.isErr()) return Result.err(found.error);
  const client = found.value;
  if (!client) {
    return Result.err(invalidClient("Unknown client. Register the client again.", basic));
  }
  if (client.tokenEndpointAuthMethod !== credentials.method) {
    return Result.err(
      invalidClient(
        `This client is registered for token_endpoint_auth_method ${client.tokenEndpointAuthMethod}.`,
        basic,
      ),
    );
  }
  if (credentials.method !== "none") {
    const stored = client.clientSecretHash;
    if (stored === null || !KeySlot.constantTimeEqual(hashSecret(credentials.secret), stored)) {
      return Result.err(invalidClient("Client authentication failed.", basic));
    }
  }
  return Result.ok(client);
};

/** True when the request carries any client identification or credentials. */
const presentsCredentials = (request: Request, form: ReadonlyMap<string, string>): boolean =>
  form.has("client_id") || /^basic /i.test(request.headers.get("authorization") ?? "");

export const OAuthClients = {
  parseRegistration,
  register,
  find,
  authenticate,
  presentsCredentials,
  hashSecret,
  logStorageError,
  tooManyRequests,
} as const;

import { createSecretKey, hkdfSync } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { z } from "zod";
import { SecretBox } from "@/lib/secret-box";
import { Base64Url } from "@/lib/vault/base64url";
import { Dek } from "@/lib/vault/dek";
import { SlotCredential } from "@/lib/vault/key-slot";
import { McpScope } from "./scopes";

/** Authorization codes: "oac_<slotId>.<secret>" (an oauth_code key slot, 60 s, single use). */
export const AUTHORIZATION_CODE_PREFIX = "oac_";
/** Refresh tokens: "ort_<slotId>.<secret>" (an oauth_refresh key slot, rotated on use). */
export const REFRESH_TOKEN_PREFIX = "ort_";
/** Access tokens: "oat_" + sealed claims (stateless, 1 h). */
export const ACCESS_TOKEN_PREFIX = "oat_";

export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
/**
 * A used code replayed by its own client within this long after redemption
 * revokes the grant (RFC 6749 section 4.1.2). Later replays only fail: an old
 * code from browser history or logs must not let anyone disconnect the user.
 */
export const AUTHORIZATION_CODE_REPLAY_WINDOW_MS = 10 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A rotated refresh token replayed within this window is a client retry, not theft. */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

export const AuthorizationCode = {
  format: (credential: SlotCredential): string =>
    SlotCredential.format(AUTHORIZATION_CODE_PREFIX, credential),
  parse: (value: string): SlotCredential | undefined =>
    SlotCredential.parse(AUTHORIZATION_CODE_PREFIX, value),
} as const;

export const RefreshToken = {
  format: (credential: SlotCredential): string =>
    SlotCredential.format(REFRESH_TOKEN_PREFIX, credential),
  parse: (value: string): SlotCredential | undefined =>
    SlotCredential.parse(REFRESH_TOKEN_PREFIX, value),
} as const;

/** What an access token asserts. `exp` is unix seconds. */
export type AccessTokenClaims = {
  readonly userId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
  readonly exp: number;
  readonly dek: Dek;
};

/** The bearer token is not an openrcs access token, was modified, or was sealed under another KEY_PEPPER. */
export class AccessTokenInvalidError extends TaggedError("AccessTokenInvalidError")<{
  reason: "malformed" | "unauthentic";
  message: string;
}> {}

const ENVELOPE_VERSION = "v1";
const ASSOCIATED_DATA = "openrcs/access-token";

/** Sealed payload; short keys keep tokens compact. */
const payloadSchema = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  gid: z.string().min(1),
  cid: z.string().min(1),
  scope: z.string(),
  exp: z.number().int(),
  did: z.string().min(1),
  dek: z.string().min(1),
});

/** AES-256-GCM key for access tokens: HKDF-SHA256(KEY_PEPPER, info = "openrcs/access-token/v1"). */
const sealingKey = (pepper: Uint8Array): SecretBox => ({
  key: createSecretKey(
    new Uint8Array(hkdfSync("sha256", pepper, new Uint8Array(0), "openrcs/access-token/v1", 32)),
  ),
});

const seal = (pepper: Uint8Array, claims: AccessTokenClaims): string => {
  const payload: z.infer<typeof payloadSchema> = {
    v: 1,
    uid: claims.userId,
    gid: claims.grantId,
    cid: claims.clientId,
    scope: McpScope.format(claims.scopes),
    exp: claims.exp,
    did: claims.dek.id,
    dek: Base64Url.encode(claims.dek.bytes),
  };
  return `${ACCESS_TOKEN_PREFIX}${SecretBox.seal(sealingKey(pepper), JSON.stringify(payload), {
    associatedData: ASSOCIATED_DATA,
    version: ENVELOPE_VERSION,
  })}`;
};

const invalid = (reason: AccessTokenInvalidError["reason"]) =>
  new AccessTokenInvalidError({
    reason,
    message:
      reason === "malformed"
        ? "The access token is not a well-formed openrcs access token."
        : "The access token was modified or was issued under a different server key.",
  });

/** Opens and authenticates a token. Does not check expiry or the grant (see McpAuth). */
const open = (pepper: Uint8Array, token: string): Result<AccessTokenClaims, AccessTokenInvalidError> => {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return Result.err(invalid("malformed"));
  const opened = SecretBox.open(sealingKey(pepper), token.slice(ACCESS_TOKEN_PREFIX.length), {
    associatedData: ASSOCIATED_DATA,
    version: ENVELOPE_VERSION,
  });
  if (opened.isErr()) {
    return Result.err(invalid(opened.error._tag === "SecretBoxAuthError" ? "unauthentic" : "malformed"));
  }
  const json = Result.try((): unknown => JSON.parse(opened.value));
  if (json.isErr()) return Result.err(invalid("malformed"));
  const parsed = payloadSchema.safeParse(json.value);
  if (!parsed.success) return Result.err(invalid("malformed"));
  const payload = parsed.data;
  const dekBytes = Base64Url.decode(payload.dek);
  const dek = dekBytes ? Dek.fromBytes(payload.did, dekBytes) : undefined;
  if (!dek) return Result.err(invalid("malformed"));
  return Result.ok({
    userId: payload.uid,
    grantId: payload.gid,
    clientId: payload.cid,
    scopes: McpScope.parse(payload.scope).scopes,
    exp: payload.exp,
    dek,
  });
};

export const AccessToken = { seal, open } as const;

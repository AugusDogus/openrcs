import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { verification } from "@/lib/db/auth-schema";
import { Base64Url } from "@/lib/vault/base64url";
import type { AuthorizationRequest } from "./authorization-request";
import type { BrowserSession, OAuthContext } from "./context";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { McpScope } from "./scopes";

/**
 * CSRF protection for the consent form: a short-lived, single-use ticket
 * signed with a key derived from BETTER_AUTH_SECRET, bound to the Better Auth
 * session and to the exact authorization request it was shown for.
 * Format: base64url(JSON claims) "." base64url(HMAC-SHA256).
 * Single use is enforced by inserting `oauth-consent:<jti>` into Better
 * Auth's `verification` table (primary key), which also expires it.
 */

export const CONSENT_TICKET_TTL_MS = 10 * 60 * 1000;
const IDENTIFIER = "openrcs-oauth-consent";

export class ConsentTicketInvalidError extends TaggedError("ConsentTicketInvalidError")<{
  reason: "malformed" | "bad_signature" | "expired" | "wrong_session" | "already_used";
  message: string;
}> {}

const claimsSchema = z.object({
  v: z.literal(1),
  jti: z.string().min(16),
  sid: z.string().min(1),
  uid: z.string().min(1),
  exp: z.number().int(),
  req: z.object({
    clientId: z.string(),
    redirectUri: z.string(),
    scope: z.string(),
    state: z.string().nullable(),
    codeChallenge: z.string(),
    resource: z.string().nullable(),
  }),
});

export type ConsentTicketClaims = {
  readonly jti: string;
  readonly exp: number;
  readonly request: AuthorizationRequest;
};

const signingKey = (secret: string): Uint8Array =>
  new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "openrcs/consent-ticket/v1", 32));

const mac = (secret: string, payload: string): Uint8Array =>
  new Uint8Array(createHmac("sha256", signingKey(secret)).update(payload).digest());

const invalid = (reason: ConsentTicketInvalidError["reason"]) =>
  new ConsentTicketInvalidError({
    reason,
    message:
      reason === "already_used"
        ? "This approval form was already submitted. Nothing more was shared. Return to the app you were connecting and start again if it did not connect."
        : reason === "wrong_session"
          ? "This approval form belongs to a different sign-in session. Nothing was shared. Return to the app you were connecting and start again."
          : "This approval form is invalid or has expired. Nothing was shared. Return to the app you were connecting and start again.",
  });

const issue = (
  ctx: Pick<OAuthContext, "ticketSecret" | "vault">,
  session: BrowserSession,
  request: AuthorizationRequest,
): string => {
  const claims: z.infer<typeof claimsSchema> = {
    v: 1,
    jti: Base64Url.encode(randomBytes(18)),
    sid: session.sessionId,
    uid: session.userId,
    exp: ctx.vault.now() + CONSENT_TICKET_TTL_MS,
    req: {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: McpScope.format(request.scopes),
      state: request.state,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
    },
  };
  const payload = Base64Url.encode(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${Base64Url.encode(mac(ctx.ticketSecret, payload))}`;
};

/** Checks signature, expiry and session binding. Does not consume. */
const verify = (
  ctx: Pick<OAuthContext, "ticketSecret" | "vault">,
  ticket: string,
  session: BrowserSession,
): Result<ConsentTicketClaims, ConsentTicketInvalidError> => {
  const parts = ticket.split(".");
  if (parts.length !== 2) return Result.err(invalid("malformed"));
  const [payload, signature] = parts;
  const presented = Base64Url.decode(signature);
  const expected = mac(ctx.ticketSecret, payload);
  if (!presented || presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    return Result.err(invalid("bad_signature"));
  }
  const bytes = Base64Url.decode(payload);
  if (!bytes) return Result.err(invalid("malformed"));
  const json = Result.try((): unknown => JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (json.isErr()) return Result.err(invalid("malformed"));
  const parsed = claimsSchema.safeParse(json.value);
  if (!parsed.success) return Result.err(invalid("malformed"));
  const claims = parsed.data;
  if (claims.exp <= ctx.vault.now()) return Result.err(invalid("expired"));
  if (claims.sid !== session.sessionId || claims.uid !== session.userId) {
    return Result.err(invalid("wrong_session"));
  }
  return Result.ok({
    jti: claims.jti,
    exp: claims.exp,
    request: {
      clientId: claims.req.clientId,
      redirectUri: claims.req.redirectUri,
      scopes: McpScope.parse(claims.req.scope).scopes,
      state: claims.req.state,
      codeChallenge: claims.req.codeChallenge,
      resource: claims.req.resource,
    },
  });
};

/** Marks the ticket used. Err(already_used) on the second call for the same ticket. */
const consume = async (
  ctx: Pick<OAuthContext, "db" | "vault">,
  claims: ConsentTicketClaims,
): Promise<Result<void, ConsentTicketInvalidError | OAuthStorageError>> => {
  const now = ctx.vault.now();
  const inserted = await Result.tryPromise({
    try: async () => {
      const [, rows] = await ctx.db.batch([
        ctx.db
          .delete(verification)
          .where(and(eq(verification.identifier, IDENTIFIER), lt(verification.expiresAt, new Date(now)))),
        ctx.db
          .insert(verification)
          .values({
            id: `oauth-consent:${claims.jti}`,
            identifier: IDENTIFIER,
            value: "used",
            expiresAt: new Date(claims.exp),
            createdAt: new Date(now),
            updatedAt: new Date(now),
          })
          .onConflictDoNothing()
          .returning({ id: verification.id }),
      ]);
      return rows.length;
    },
    catch: (cause) => OAuthErrors.storage("consume consent ticket", cause),
  });
  if (inserted.isErr()) return Result.err(inserted.error);
  return inserted.value === 1 ? Result.ok() : Result.err(invalid("already_used"));
};

export const ConsentTicket = { issue, verify, consume } as const;

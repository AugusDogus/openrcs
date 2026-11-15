import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * Vault and OAuth authorization server tables (docs/security.md). Client
 * secrets (authorization codes, refresh tokens) never reach the database,
 * only a one-way `verifier`. `user_key.wrapped_dek` opens with KEY_PEPPER.
 */

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

const userIdRef = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

export const OAUTH_CLIENT_AUTH_METHODS = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;
export type OAuthClientAuthMethod = (typeof OAUTH_CLIENT_AUTH_METHODS)[number];

/** Dynamically registered OAuth clients (RFC 7591). */
export const oauthClient = sqliteTable("oauth_client", {
  clientId: text("client_id").primaryKey(),
  /** SHA-256 (base64url) of the client secret; null for public clients. */
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  /** JSON array of exact redirect URIs. */
  redirectUrisJson: text("redirect_uris_json").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method", {
    enum: OAUTH_CLIENT_AUTH_METHODS,
  }).notNull(),
  /** Space-separated scopes the client registered for. */
  scope: text("scope").notNull(),
  clientUri: text("client_uri"),
  logoUri: text("logo_uri"),
  createdAt: integer("created_at").default(nowMs).notNull(),
});

/** A user's authorization of one client. Revoking it kills its refresh tokens and access tokens. */
export const oauthGrant = sqliteTable(
  "oauth_grant",
  {
    id: text("id").primaryKey(),
    userId: userIdRef(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    /** Space-separated granted scopes. */
    scope: text("scope").notNull(),
    createdAt: integer("created_at").default(nowMs).notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (table) => [index("oauth_grant_user_idx").on(table.userId)],
);

export const KEY_SLOT_KINDS = ["oauth_code", "oauth_refresh"] as const;
export type KeySlotKind = (typeof KEY_SLOT_KINDS)[number];

/**
 * An OAuth credential the client holds (an authorization code or a refresh
 * token): its id and secret verifier, lifecycle and replay state. The table
 * keeps its historical name from when slots also wrapped a DEK.
 */
export const keySlot = sqliteTable(
  "key_slot",
  {
    id: text("id").primaryKey(),
    userId: userIdRef(),
    kind: text("kind", { enum: KEY_SLOT_KINDS }).notNull(),
    /** base64url SHA-256 verifier of the slot secret (see docs/security.md). */
    verifier: text("verifier").notNull(),
    grantId: text("grant_id").references(() => oauthGrant.id, { onDelete: "cascade" }),
    /** Non-secret JSON for oauth_code slots: client id, redirect URI, PKCE challenge, scope, resource. */
    payloadJson: text("payload_json"),
    createdAt: integer("created_at").default(nowMs).notNull(),
    /** Unix epoch ms; null means no expiry. */
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    /** Set when a code is redeemed or a refresh token is rotated. */
    consumedAt: integer("consumed_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("key_slot_user_kind_idx").on(table.userId, table.kind),
    index("key_slot_grant_idx").on(table.grantId),
    check("key_slot_kind_check", sql`${table.kind} in ('oauth_code', 'oauth_refresh')`),
  ],
);

/**
 * The server's copy of each user's DEK, wrapped under a key derived from
 * KEY_PEPPER alone (src/lib/vault/server-key.ts), so the server can open the
 * user's data without a client.
 */
export const userKey = sqliteTable("user_key", {
  userId: userIdRef().primaryKey(),
  dekId: text("dek_id").notNull(),
  /** AES-256-GCM envelope of the DEK under the server KEK. */
  wrappedDek: text("wrapped_dek").notNull(),
  createdAt: integer("created_at").default(nowMs).notNull(),
});

/** Fixed-window request counters for unauthenticated endpoints (DCR, token, pairing). */
export const requestThrottle = sqliteTable("request_throttle", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});

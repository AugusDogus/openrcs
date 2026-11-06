import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * App tables. Conventions:
 * - `*_at` audit columns are `timestamp_ms` (Date in TS, integer ms in SQL).
 * - Message/lease times that are compared or sorted numerically
 *   (`timestamp`, `last_message_ts`, `expires_at`) are plain integer ms.
 * - `*_json` columns hold JSON text; parse and validate at the read boundary.
 */

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull();

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .default(nowMs)
    .$onUpdate(() => new Date())
    .notNull();

const userIdRef = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

export const GM_SESSION_KINDS = ["gaia", "qr"] as const;
export type GmSessionKind = (typeof GM_SESSION_KINDS)[number];

export const GM_SESSION_STATUSES = ["paired", "needs_repair", "unpaired"] as const;
export type GmSessionStatus = (typeof GM_SESSION_STATUSES)[number];

/**
 * One paired Google Messages web session per user. `auth_data_enc` is a
 * DataBox envelope sealed with the user's DEK (docs/security.md). `dek_id`
 * identifies the DEK generation; key slots carry the same id so a stale slot
 * is detected instead of failing to decrypt.
 */
export const gmSession = sqliteTable(
  "gm_session",
  {
    userId: userIdRef().primaryKey(),
    kind: text("kind", { enum: GM_SESSION_KINDS }).notNull(),
    status: text("status", { enum: GM_SESSION_STATUSES }).notNull(),
    dekId: text("dek_id").notNull(),
    authDataEnc: text("auth_data_enc").notNull(),
    phoneLabel: text("phone_label"),
    lastConnectedAt: integer("last_connected_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("gm_session_kind_check", sql`${table.kind} in ('gaia', 'qr')`),
    check(
      "gm_session_status_check",
      sql`${table.status} in ('paired', 'needs_repair', 'unpaired')`,
    ),
  ],
);

/** Per-user mutex so only one function invocation talks to the phone at a time. */
export const phoneLease = sqliteTable("phone_lease", {
  userId: userIdRef().primaryKey(),
  holder: text("holder").notNull(),
  /** Lease expiry, unix epoch milliseconds. */
  expiresAt: integer("expires_at").notNull(),
});

/**
 * Conversations. `content_enc` is a DataBox envelope (user's DEK) holding
 * JSON `{ name, participants, lastMessagePreview }`; everything else is
 * non-sensitive metadata used for ordering and filtering.
 */
export const conversation = sqliteTable(
  "conversation",
  {
    userId: userIdRef(),
    conversationId: text("conversation_id").notNull(),
    contentEnc: text("content_enc").notNull(),
    isGroup: integer("is_group", { mode: "boolean" }).notNull(),
    /** Unix epoch milliseconds of the latest message. */
    lastMessageTs: integer("last_message_ts").notNull(),
    /** Newest message timestamp (ms) already fetched into `message`; drives incremental sync. */
    syncedMessageTs: integer("synced_message_ts"),
    unread: integer("unread", { mode: "boolean" }).notNull(),
    readOnly: integer("read_only", { mode: "boolean" }).notNull(),
    status: text("status").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.conversationId] }),
    index("conversation_user_last_message_idx").on(table.userId, table.lastMessageTs),
  ],
);

/**
 * Messages. `(user_id, message_id)` is the logical key (unique index; use it
 * as the upsert conflict target). `content_enc` is a DataBox envelope (user's
 * DEK) holding JSON `{ body, senderName, senderNumber, media, reactions }`.
 * Search decrypts candidate rows in memory; there is no plaintext index.
 */
export const message = sqliteTable(
  "message",
  {
    id: integer("id").primaryKey(),
    userId: userIdRef(),
    messageId: text("message_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    fromMe: integer("from_me", { mode: "boolean" }).notNull(),
    contentEnc: text("content_enc").notNull(),
    /** Unix epoch milliseconds. */
    timestamp: integer("timestamp").notNull(),
    status: text("status").notNull(),
    replyToId: text("reply_to_id"),
    /** Client temp id for messages we sent, until the phone echoes the real one. */
    tmpId: text("tmp_id"),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("message_user_message_uidx").on(table.userId, table.messageId),
    index("message_user_conversation_ts_idx").on(
      table.userId,
      table.conversationId,
      table.timestamp,
    ),
    index("message_user_ts_idx").on(table.userId, table.timestamp),
  ],
);

export const syncState = sqliteTable("sync_state", {
  userId: userIdRef().primaryKey(),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  lastSyncError: text("last_sync_error"),
  backfillCursorJson: text("backfill_cursor_json"),
});

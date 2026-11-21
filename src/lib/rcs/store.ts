import { Result } from "better-result";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { conversation, message, syncState } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import type { PlainConversation, PlainMessage } from "@/lib/gm/message";
import { DataBox, type DataBoxAad } from "@/lib/vault/data-box";
import type { RcsContext } from "./context";
import { RcsStorageError } from "./errors";
import { SearchQuery, type SearchQueryError } from "./search-query";

/**
 * Encrypted message store. Content columns are DataBox envelopes sealed with
 * the user's DEK under the contract AAD (docs/vault-contract.md); the other
 * columns are the plaintext metadata listed in app-schema.ts. Reads decrypt in
 * memory; rows that fail to open (wrong key, tampering) are skipped and
 * counted, never returned half-decoded.
 */

const ParticipantSchema = z.object({
  participantId: z.string(),
  name: z.string().nullable(),
  number: z.string().nullable(),
  isMe: z.boolean(),
});

/** Decrypted `conversation.content_enc`. */
export const ConversationContentSchema = z.object({
  name: z.string(),
  participants: z.array(ParticipantSchema),
  lastMessagePreview: z.string().nullable(),
});
export type ConversationContent = z.infer<typeof ConversationContentSchema>;

/** Decrypted `message.content_enc`. */
export const MessageContentSchema = z.object({
  body: z.string(),
  senderName: z.string().nullable(),
  senderNumber: z.string().nullable(),
  media: z
    .object({
      mediaId: z.string(),
      mimeType: z.string(),
      name: z.string(),
      size: z.number(),
      /** Attachment key (base64). Absent on rows stored before keys were kept. */
      key: z.string().nullable().default(null),
      thumbnail: z.boolean().default(false),
      partId: z.string().nullable().default(null),
    })
    .nullable(),
  reactions: z.array(
    z.object({ emoji: z.string(), count: z.number(), participantIds: z.array(z.string()) }),
  ),
});
export type MessageContent = z.infer<typeof MessageContentSchema>;

export type StoredConversation = ConversationContent & {
  readonly conversationId: string;
  readonly isGroup: boolean;
  readonly lastMessageTimestampMs: number;
  readonly unread: boolean;
  readonly readOnly: boolean;
  readonly status: string;
  readonly syncedMessageTs: number | null;
};

export type StoredMessage = MessageContent & {
  readonly messageId: string;
  readonly conversationId: string;
  readonly timestampMs: number;
  readonly fromMe: boolean;
  readonly status: string;
  readonly replyToId: string | null;
  readonly tmpId: string | null;
};

export type SearchHit = StoredMessage & { readonly conversationName: string | null };

export type SearchRequest = {
  readonly query: string;
  readonly conversationId?: string;
  /** Inclusive lower bound, epoch ms. */
  readonly sinceMs?: number;
  /** Exclusive upper bound, epoch ms. */
  readonly untilMs?: number;
  readonly limit: number;
  /** Rows decrypted per batch. Default 1000. */
  readonly batchSize?: number;
  /** Stop after decrypting this many rows. Default 20,000. */
  readonly scanCap?: number;
};

export type SearchResult = {
  /** Newest first. */
  readonly hits: readonly SearchHit[];
  /** Rows decrypted and checked. */
  readonly scannedCount: number;
  /** Rows matching the user/conversation/time filters before text matching. */
  readonly totalCandidates: number;
  /** True when the scan cap stopped the search before every candidate was checked. */
  readonly capped: boolean;
  /** True when `limit` hits were found before every candidate was checked. */
  readonly limitReached: boolean;
  /** Rows that could not be decrypted and were skipped. */
  readonly unreadable: number;
};

export const DEFAULT_SEARCH_BATCH = 1_000;
export const DEFAULT_SCAN_CAP = 20_000;
const WRITE_CHUNK = 100;

const conversationAad = (userId: string, conversationId: string): DataBoxAad => ({
  userId,
  table: "conversation",
  rowKey: conversationId,
  column: "content",
});

const messageAad = (userId: string, messageId: string): DataBoxAad => ({
  userId,
  table: "message",
  rowKey: messageId,
  column: "content",
});

const storageError = (operation: string, userId: string, cause: unknown) =>
  new RcsStorageError({
    operation,
    userId,
    cause,
    message:
      "openrcs could not read or write your stored messages because the database did not respond. Nothing was lost; try again in a moment.",
  });

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const runBatch = async (db: Database, statements: BatchItem<"sqlite">[]): Promise<void> => {
  const [first, ...rest] = statements;
  if (first === undefined) return;
  await db.batch([first, ...rest]);
};

/** Last value wins for duplicate keys, keeping first-seen order. */
const dedupeBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return [...map.values()];
};

const upsertConversations = (
  db: Database,
  ctx: RcsContext,
  conversations: readonly PlainConversation[],
): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const now = new Date();
      const valid = conversations.filter((c) => c.conversationId !== "");
      const rows = dedupeBy(valid, (c) => c.conversationId).map((c) => ({
        userId: ctx.userId,
        conversationId: c.conversationId,
        contentEnc: DataBox.sealJson(
          ctx.dek,
          {
            name: c.name,
            participants: c.participants,
            lastMessagePreview: c.lastMessagePreview,
          } satisfies ConversationContent,
          conversationAad(ctx.userId, c.conversationId),
        ),
        isGroup: c.isGroup,
        lastMessageTs: c.lastMessageTimestampMs,
        unread: c.unread,
        readOnly: c.readOnly,
        status: c.status,
        updatedAt: now,
      }));
      await runBatch(
        db,
        chunks(rows, WRITE_CHUNK).map((chunk) =>
          db
            .insert(conversation)
            .values(chunk)
            .onConflictDoUpdate({
              target: [conversation.userId, conversation.conversationId],
              set: {
                contentEnc: sql`excluded.content_enc`,
                isGroup: sql`excluded.is_group`,
                lastMessageTs: sql`excluded.last_message_ts`,
                unread: sql`excluded.unread`,
                readOnly: sql`excluded.read_only`,
                status: sql`excluded.status`,
                updatedAt: sql`excluded.updated_at`,
              },
            }),
        ),
      );
    },
    catch: (cause) => storageError("store.upsertConversations", ctx.userId, cause),
  });

/** How far apart the server's time on a placeholder and the phone's time on the same message may be. */
const PLACEHOLDER_MATCH_MS = 10 * 60_000;

/**
 * The placeholders (rows stored at send time under their temp id) that these
 * outgoing messages are the real copies of although they carry no temp id, as
 * a background sync's copy does not: same conversation and text, within
 * PLACEHOLDER_MATCH_MS. Each message claims at most one placeholder, the
 * closest in time, so two identical sends need two real copies.
 */
const placeholdersSyncedAs = async (
  db: Database,
  ctx: RcsContext,
  messages: readonly PlainMessage[],
): Promise<string[]> => {
  const copies = messages.filter((m) => m.fromMe && m.tmpId === null);
  if (copies.length === 0) return [];
  const rows = await db
    .select(messageColumns)
    .from(message)
    .where(
      and(
        eq(message.userId, ctx.userId),
        eq(message.fromMe, true),
        sql`${message.messageId} = ${message.tmpId}`,
        inArray(message.conversationId, [...new Set(copies.map((m) => m.conversationId))]),
      ),
    );
  const placeholders = rows
    .map((row) => openMessage(ctx, row))
    .filter((m): m is StoredMessage => m !== null);
  const claimed = new Set<string>();
  for (const copy of copies) {
    const distance = (p: StoredMessage) => Math.abs(p.timestampMs - copy.timestampMs);
    const [closest] = placeholders
      .filter(
        (p) =>
          !claimed.has(p.messageId) &&
          p.conversationId === copy.conversationId &&
          p.body === copy.body &&
          distance(p) <= PLACEHOLDER_MATCH_MS,
      )
      .sort((a, b) => distance(a) - distance(b));
    if (closest !== undefined) claimed.add(closest.messageId);
  }
  return [...claimed];
};

/**
 * Upsert messages on (user_id, message_id). A real copy of a message we sent
 * replaces the placeholder stored at send time: by its temp id when it carries
 * one (the phone's echo), otherwise by text and time (placeholdersSyncedAs).
 */
const upsertMessages = (
  db: Database,
  ctx: RcsContext,
  messages: readonly PlainMessage[],
): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const now = new Date();
      const unique = dedupeBy(
        messages.filter((m) => m.messageId !== "" && m.conversationId !== ""),
        (m) => m.messageId,
      );
      const rows = unique.map((m) => ({
        userId: ctx.userId,
        messageId: m.messageId,
        conversationId: m.conversationId,
        fromMe: m.fromMe,
        contentEnc: DataBox.sealJson(
          ctx.dek,
          {
            body: m.body,
            senderName: m.senderName,
            senderNumber: m.senderNumber,
            media: m.media,
            reactions: m.reactions,
          } satisfies MessageContent,
          messageAad(ctx.userId, m.messageId),
        ),
        timestamp: m.timestampMs,
        status: m.status,
        replyToId: m.replyToId,
        tmpId: m.tmpId,
        updatedAt: now,
      }));
      const echoedTmpIds = unique
        .map((m) => m.tmpId)
        .filter((tmpId): tmpId is string => tmpId !== null && tmpId !== "");
      const replacedTmpIds = [...new Set([...echoedTmpIds, ...(await placeholdersSyncedAs(db, ctx, unique))])].filter(
        (tmpId) => !unique.some((m) => m.messageId === tmpId),
      );
      const statements: BatchItem<"sqlite">[] = chunks(replacedTmpIds, WRITE_CHUNK).map((ids) =>
        db.delete(message).where(and(eq(message.userId, ctx.userId), inArray(message.messageId, ids))),
      );
      for (const chunk of chunks(rows, WRITE_CHUNK)) {
        statements.push(
          db
            .insert(message)
            .values(chunk)
            .onConflictDoUpdate({
              target: [message.userId, message.messageId],
              set: {
                conversationId: sql`excluded.conversation_id`,
                fromMe: sql`excluded.from_me`,
                contentEnc: sql`excluded.content_enc`,
                timestamp: sql`excluded.timestamp`,
                status: sql`excluded.status`,
                replyToId: sql`excluded.reply_to_id`,
                tmpId: sql`excluded.tmp_id`,
                updatedAt: sql`excluded.updated_at`,
              },
            }),
        );
      }
      await runBatch(db, statements);
    },
    catch: (cause) => storageError("store.upsertMessages", ctx.userId, cause),
  });

type ConversationRow = {
  conversationId: string;
  contentEnc: string;
  isGroup: boolean;
  lastMessageTs: number;
  unread: boolean;
  readOnly: boolean;
  status: string;
  syncedMessageTs: number | null;
};

const conversationColumns = {
  conversationId: conversation.conversationId,
  contentEnc: conversation.contentEnc,
  isGroup: conversation.isGroup,
  lastMessageTs: conversation.lastMessageTs,
  unread: conversation.unread,
  readOnly: conversation.readOnly,
  status: conversation.status,
  syncedMessageTs: conversation.syncedMessageTs,
} as const;

const openConversation = (ctx: RcsContext, row: ConversationRow): StoredConversation | null =>
  DataBox.openJson(
    ctx.dek,
    row.contentEnc,
    conversationAad(ctx.userId, row.conversationId),
    ConversationContentSchema,
  ).match({
    ok: (content) => ({
      ...content,
      conversationId: row.conversationId,
      isGroup: row.isGroup,
      lastMessageTimestampMs: row.lastMessageTs,
      unread: row.unread,
      readOnly: row.readOnly,
      status: row.status,
      syncedMessageTs: row.syncedMessageTs,
    }),
    err: () => null,
  });

type MessageRow = {
  id: number;
  messageId: string;
  conversationId: string;
  fromMe: boolean;
  contentEnc: string;
  timestamp: number;
  status: string;
  replyToId: string | null;
  tmpId: string | null;
};

const messageColumns = {
  id: message.id,
  messageId: message.messageId,
  conversationId: message.conversationId,
  fromMe: message.fromMe,
  contentEnc: message.contentEnc,
  timestamp: message.timestamp,
  status: message.status,
  replyToId: message.replyToId,
  tmpId: message.tmpId,
} as const;

const openMessage = (ctx: RcsContext, row: MessageRow): StoredMessage | null =>
  DataBox.openJson(
    ctx.dek,
    row.contentEnc,
    messageAad(ctx.userId, row.messageId),
    MessageContentSchema,
  ).match({
    ok: (content) => ({
      ...content,
      messageId: row.messageId,
      conversationId: row.conversationId,
      timestampMs: row.timestamp,
      fromMe: row.fromMe,
      status: row.status,
      replyToId: row.replyToId,
      tmpId: row.tmpId,
    }),
    err: () => null,
  });

const conversationMatches = (query: SearchQuery, c: StoredConversation): boolean =>
  SearchQuery.matches(query, {
    text: [c.name, ...c.participants.flatMap((p) => [p.name, p.number])],
    numbers: c.participants.map((p) => p.number),
  });

export type ConversationList = {
  /** Newest activity first. */
  readonly conversations: readonly StoredConversation[];
  readonly unreadable: number;
};

/**
 * Conversations newest first. With `query`, every stored conversation is
 * decrypted and filtered by name and participant names/numbers.
 */
const listConversations = async (
  db: Database,
  ctx: RcsContext,
  opts: { limit: number; query?: string },
): Promise<Result<ConversationList, RcsStorageError | SearchQueryError>> => {
  const trimmed = opts.query?.trim() ?? "";
  let query: SearchQuery | null = null;
  if (trimmed !== "") {
    const parsed = SearchQuery.parse(trimmed);
    if (parsed.isErr()) return Result.err(parsed.error);
    query = parsed.value;
  }
  const rows = await Result.tryPromise({
    try: () => {
      const select = db
        .select(conversationColumns)
        .from(conversation)
        .where(eq(conversation.userId, ctx.userId))
        .orderBy(desc(conversation.lastMessageTs), desc(conversation.conversationId));
      return query === null ? select.limit(opts.limit) : select;
    },
    catch: (cause) => storageError("store.listConversations", ctx.userId, cause),
  });
  if (rows.isErr()) return Result.err(rows.error);
  const conversations: StoredConversation[] = [];
  let unreadable = 0;
  for (const row of rows.value) {
    const opened = openConversation(ctx, row);
    if (opened === null) {
      unreadable += 1;
      continue;
    }
    if (query !== null && !conversationMatches(query, opened)) continue;
    conversations.push(opened);
    if (conversations.length >= opts.limit) break;
  }
  return Result.ok({ conversations, unreadable });
};

const getConversation = async (
  db: Database,
  ctx: RcsContext,
  conversationId: string,
): Promise<Result<StoredConversation | null, RcsStorageError>> => {
  const rows = await Result.tryPromise({
    try: () =>
      db
        .select(conversationColumns)
        .from(conversation)
        .where(
          and(eq(conversation.userId, ctx.userId), eq(conversation.conversationId, conversationId)),
        )
        .limit(1),
    catch: (cause) => storageError("store.getConversation", ctx.userId, cause),
  });
  if (rows.isErr()) return Result.err(rows.error);
  const [row] = rows.value;
  return Result.ok(row === undefined ? null : openConversation(ctx, row));
};

export type MessagePage = {
  /** Oldest first (chat order). Use the first message's timestamp as the next `beforeMs`. */
  readonly messages: readonly StoredMessage[];
  readonly unreadable: number;
};

/** The newest `limit` messages of a conversation, optionally strictly before `beforeMs`. */
const getMessages = async (
  db: Database,
  ctx: RcsContext,
  conversationId: string,
  opts: { limit: number; beforeMs?: number },
): Promise<Result<MessagePage, RcsStorageError>> => {
  const rows = await Result.tryPromise({
    try: () =>
      db
        .select(messageColumns)
        .from(message)
        .where(
          and(
            eq(message.userId, ctx.userId),
            eq(message.conversationId, conversationId),
            opts.beforeMs === undefined ? undefined : lt(message.timestamp, opts.beforeMs),
          ),
        )
        .orderBy(desc(message.timestamp), desc(message.id))
        .limit(opts.limit),
    catch: (cause) => storageError("store.getMessages", ctx.userId, cause),
  });
  if (rows.isErr()) return Result.err(rows.error);
  const messages: StoredMessage[] = [];
  let unreadable = 0;
  for (const row of rows.value) {
    const opened = openMessage(ctx, row);
    if (opened === null) unreadable += 1;
    else messages.push(opened);
  }
  return Result.ok({ messages: messages.reverse(), unreadable });
};

/** One stored message by id, or null when it is not stored or cannot be decrypted. */
const getMessage = async (
  db: Database,
  ctx: RcsContext,
  messageId: string,
): Promise<Result<StoredMessage | null, RcsStorageError>> => {
  const rows = await Result.tryPromise({
    try: () =>
      db
        .select(messageColumns)
        .from(message)
        .where(and(eq(message.userId, ctx.userId), eq(message.messageId, messageId)))
        .limit(1),
    catch: (cause) => storageError("store.getMessage", ctx.userId, cause),
  });
  if (rows.isErr()) return Result.err(rows.error);
  const [row] = rows.value;
  return Result.ok(row === undefined ? null : openMessage(ctx, row));
};

/** The oldest message of the conversation that is newer than `timestampMs`, or null. */
const nextNewerMessage = (
  db: Database,
  userId: string,
  conversationId: string,
  timestampMs: number,
): Promise<Result<{ messageId: string; timestampMs: number } | null, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select({ messageId: message.messageId, timestampMs: message.timestamp })
        .from(message)
        .where(
          and(
            eq(message.userId, userId),
            eq(message.conversationId, conversationId),
            gt(message.timestamp, timestampMs),
          ),
        )
        .orderBy(asc(message.timestamp), asc(message.id))
        .limit(1);
      return row ?? null;
    },
    catch: (cause) => storageError("store.nextNewerMessage", userId, cause),
  });

/**
 * Decrypt-and-scan search. SQL narrows candidates by user, conversation and
 * time window (newest first, keyset-paginated in batches); each batch is
 * decrypted and matched in memory until `limit` hits or `scanCap` rows.
 */
const searchMessages = async (
  db: Database,
  ctx: RcsContext,
  request: SearchRequest,
): Promise<Result<SearchResult, RcsStorageError | SearchQueryError>> => {
  const parsed = SearchQuery.parse(request.query);
  if (parsed.isErr()) return Result.err(parsed.error);
  const query = parsed.value;
  const batchSize = Math.max(1, request.batchSize ?? DEFAULT_SEARCH_BATCH);
  const scanCap = Math.max(1, request.scanCap ?? DEFAULT_SCAN_CAP);
  const limit = Math.max(1, request.limit);

  const filters: (SQL | undefined)[] = [
    eq(message.userId, ctx.userId),
    request.conversationId === undefined
      ? undefined
      : eq(message.conversationId, request.conversationId),
    request.sinceMs === undefined ? undefined : gte(message.timestamp, request.sinceMs),
    request.untilMs === undefined ? undefined : lt(message.timestamp, request.untilMs),
  ];

  const names = new Map<string, string>();
  const prelude = await Result.tryPromise({
    try: async () => {
      const [total] = await db
        .select({ value: count() })
        .from(message)
        .where(and(...filters));
      const conversationRows = await db
        .select(conversationColumns)
        .from(conversation)
        .where(
          request.conversationId === undefined
            ? eq(conversation.userId, ctx.userId)
            : and(
                eq(conversation.userId, ctx.userId),
                eq(conversation.conversationId, request.conversationId),
              ),
        );
      return { total: total?.value ?? 0, conversationRows };
    },
    catch: (cause) => storageError("store.searchMessages", ctx.userId, cause),
  });
  if (prelude.isErr()) return Result.err(prelude.error);
  for (const row of prelude.value.conversationRows) {
    const opened = openConversation(ctx, row);
    if (opened !== null) names.set(row.conversationId, opened.name);
  }
  const preparedNames = new Map<string, string>();
  for (const [id, name] of names) preparedNames.set(id, SearchQuery.normalize(name));

  const hits: SearchHit[] = [];
  let scanned = 0;
  let unreadable = 0;
  let cursor: { timestamp: number; id: number } | null = null;
  let exhausted = false;

  while (hits.length < limit && scanned < scanCap) {
    const take = Math.min(batchSize, scanCap - scanned);
    const after: { timestamp: number; id: number } | null = cursor;
    const batch: Result<MessageRow[], RcsStorageError> = await Result.tryPromise({
      try: (): Promise<MessageRow[]> =>
        db
          .select(messageColumns)
          .from(message)
          .where(
            and(
              ...filters,
              after === null
                ? undefined
                : sql`(${message.timestamp}, ${message.id}) < (${after.timestamp}, ${after.id})`,
            ),
          )
          .orderBy(desc(message.timestamp), desc(message.id))
          .limit(take),
      catch: (cause) => storageError("store.searchMessages", ctx.userId, cause),
    });
    if (batch.isErr()) return Result.err(batch.error);
    const rows = batch.value;
    for (const row of rows) {
      scanned += 1;
      cursor = { timestamp: row.timestamp, id: row.id };
      const opened = openMessage(ctx, row);
      if (opened === null) {
        unreadable += 1;
        continue;
      }
      const conversationName = names.get(row.conversationId) ?? null;
      const fields = SearchQuery.prepare({
        text: [opened.body, opened.senderName, opened.senderNumber],
        numbers: [opened.senderNumber],
      });
      const withName = {
        text: [fields.text, preparedNames.get(row.conversationId) ?? ""].join("\n"),
        digits: fields.digits,
      };
      if (SearchQuery.matches(query, withName)) {
        hits.push({ ...opened, conversationName });
        if (hits.length >= limit) break;
      }
    }
    if (rows.length < take) {
      exhausted = true;
      break;
    }
  }

  const remaining = !exhausted && scanned < prelude.value.total;
  return Result.ok({
    hits,
    scannedCount: scanned,
    totalCandidates: prelude.value.total,
    capped: remaining && scanned >= scanCap && hits.length < limit,
    limitReached: remaining && hits.length >= limit,
    unreadable,
  });
};

/** Stored counts for status reporting. */
const counts = (
  db: Database,
  userId: string,
): Promise<Result<{ conversations: number; messages: number }, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [conversations] = await db
        .select({ value: count() })
        .from(conversation)
        .where(eq(conversation.userId, userId));
      const [messages] = await db
        .select({ value: count() })
        .from(message)
        .where(eq(message.userId, userId));
      return { conversations: conversations?.value ?? 0, messages: messages?.value ?? 0 };
    },
    catch: (cause) => storageError("store.counts", userId, cause),
  });

/** `synced_message_ts` for the given conversations (missing rows are absent from the map). */
const syncedTimestamps = (
  db: Database,
  userId: string,
  conversationIds: readonly string[],
): Promise<Result<Map<string, number | null>, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const map = new Map<string, number | null>();
      for (const ids of chunks(conversationIds, 500)) {
        const rows = await db
          .select({ id: conversation.conversationId, ts: conversation.syncedMessageTs })
          .from(conversation)
          .where(and(eq(conversation.userId, userId), inArray(conversation.conversationId, ids)));
        for (const row of rows) map.set(row.id, row.ts);
      }
      return map;
    },
    catch: (cause) => storageError("store.syncedTimestamps", userId, cause),
  });

const setSyncedTimestamp = (
  db: Database,
  userId: string,
  conversationId: string,
  syncedMessageTs: number,
): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db
        .update(conversation)
        .set({ syncedMessageTs })
        .where(
          and(eq(conversation.userId, userId), eq(conversation.conversationId, conversationId)),
        );
    },
    catch: (cause) => storageError("store.setSyncedTimestamp", userId, cause),
  });

/** Delete every stored conversation, message and sync state of the user. No DEK needed. */
const deleteUserData = (db: Database, userId: string): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: () =>
      runBatch(db, [
        db.delete(message).where(eq(message.userId, userId)),
        db.delete(conversation).where(eq(conversation.userId, userId)),
        db.delete(syncState).where(eq(syncState.userId, userId)),
      ]),
    catch: (cause) => storageError("store.deleteUserData", userId, cause),
  });

export const Store = {
  conversationAad,
  messageAad,
  upsertConversations,
  upsertMessages,
  listConversations,
  getConversation,
  getMessages,
  getMessage,
  nextNewerMessage,
  searchMessages,
  counts,
  syncedTimestamps,
  setSyncedTimestamp,
  deleteUserData,
} as const;

export { deleteUserData, getMessages, listConversations, searchMessages };

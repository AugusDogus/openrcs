import { Result } from "better-result";
import { ListConversationsRequest_Folder, type Cursor } from "@/gen/gmproto/client_pb";
import type { Database } from "@/lib/db/client";
import type { GMClient } from "@/lib/gm/client";
import { GMConversation, GMMessage, type PlainConversation } from "@/lib/gm/message";
import type { RcsContext } from "./context";
import {
  describeForLog,
  GmFailure,
  RcsAbortedError,
  type RcsPhoneAccessError,
  type RcsPhoneError,
  type RcsStorageError,
} from "./errors";
import { describePhoneError, withPhone, type WithPhoneOptions } from "./phone";
import { Store } from "./store";
import { SyncState } from "./sync-state";

/**
 * Incremental sync from the phone into the encrypted store. Conversations are
 * listed newest first; a conversation is fetched only when its last message is
 * newer than `synced_message_ts`, newest page first, paging back until the
 * stored boundary or the page cap. Events that arrive on the long poll are
 * stored by `withPhone`. Work stops before any RPC that would start after the
 * deadline; what was stored stays stored.
 */
export type SyncLimits = {
  /** Conversations to list from the phone (newest first). */
  readonly conversationCount: number;
  /** Messages requested per page. */
  readonly messagesPerPage: number;
  /** Pages fetched per conversation before stopping (older history is left for later). */
  readonly maxPagesPerConversation: number;
};

export const SyncLimits = {
  /** Throttled sync on tool calls and "Sync now". */
  incremental: { conversationCount: 25, messagesPerPage: 30, maxPagesPerConversation: 3 },
  /** Right after pairing. */
  backfill: { conversationCount: 100, messagesPerPage: 50, maxPagesPerConversation: 4 },
} as const satisfies Record<string, SyncLimits>;

export type SyncProgress = {
  readonly conversationsDone: number;
  readonly conversationsTotal: number;
};

export type SyncOptions = SyncLimits & {
  /** Absolute deadline in epoch ms (compare with `Date.now()`). */
  readonly deadlineMs: number;
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly signal?: AbortSignal;
  /** Passed to `withPhone` (tests inject `createClient`; pairing passes its held lease). */
  readonly phone?: WithPhoneOptions;
  readonly now?: () => number;
};

export type SyncSummary = {
  readonly conversationsListed: number;
  /** Conversations with messages newer than what is stored. */
  readonly conversationsToSync: number;
  readonly conversationsSynced: number;
  readonly messagesStored: number;
  /** Conversations where the page cap stopped paging before the stored boundary. */
  readonly truncatedConversations: number;
  /** True when the deadline stopped the sync; remaining conversations sync next time. */
  readonly deadlineReached: boolean;
};

const LIST_PAGE = 50;
/** Leave this much of the budget for draining events, closing and persisting. */
const QUIET_BUDGET_MS = 5_000;

type PagingOutcome = "complete" | "pageCap" | "deadline";

type Clock = { readonly now: () => number; readonly deadlineMs: number; readonly signal?: AbortSignal };

const expired = (clock: Clock) => clock.signal?.aborted === true || clock.now() >= clock.deadlineMs;

/**
 * Fetch one conversation newest page first until a page reaches
 * `syncedMessageTs`, history ends, the page cap is hit, or the deadline.
 */
const pageConversation = async (
  client: GMClient,
  db: Database,
  ctx: RcsContext,
  conversationId: string,
  syncedMessageTs: number | null,
  limits: Pick<SyncLimits, "messagesPerPage" | "maxPagesPerConversation">,
  clock: Clock,
): Promise<
  Result<
    { stored: number; newestTs: number | null; outcome: PagingOutcome },
    RcsPhoneError | RcsStorageError
  >
> => {
  let cursor: Cursor | undefined;
  let stored = 0;
  let newestTs: number | null = null;
  for (let page = 0; page < limits.maxPagesPerConversation; page += 1) {
    if (expired(clock)) return Result.ok({ stored, newestTs, outcome: "deadline" });
    const response = await client.fetchMessages({
      conversationId,
      count: limits.messagesPerPage,
      cursor,
    });
    if (response.isErr()) {
      return Result.err(GmFailure.toPhoneError(ctx.userId, "sync.fetchMessages", response.error));
    }
    const messages = response.value.messages.map(GMMessage.toPlain);
    if (messages.length > 0) {
      const upserted = await Store.upsertMessages(db, ctx, messages);
      if (upserted.isErr()) return Result.err(upserted.error);
      stored += messages.length;
    }
    const timestamps = messages.map((m) => m.timestampMs);
    if (timestamps.length > 0) newestTs = Math.max(newestTs ?? 0, ...timestamps);
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const nextCursor = response.value.cursor;
    if (
      oldest === null ||
      (syncedMessageTs !== null && oldest <= syncedMessageTs) ||
      nextCursor === undefined
    ) {
      return Result.ok({ stored, newestTs, outcome: "complete" });
    }
    cursor = nextCursor;
  }
  return Result.ok({ stored, newestTs, outcome: "pageCap" });
};

const listInbox = async (
  client: GMClient,
  db: Database,
  ctx: RcsContext,
  count: number,
  clock: Clock,
): Promise<
  Result<{ conversations: PlainConversation[]; deadlineReached: boolean }, RcsPhoneError | RcsStorageError>
> => {
  const byId = new Map<string, PlainConversation>();
  let cursor: Cursor | undefined;
  while (byId.size < count) {
    if (expired(clock)) return Result.ok({ conversations: [...byId.values()], deadlineReached: true });
    const want = Math.min(LIST_PAGE, count - byId.size);
    const page = await client.listConversations({
      count: want,
      folder: ListConversationsRequest_Folder.INBOX,
      cursor,
    });
    if (page.isErr()) {
      return Result.err(GmFailure.toPhoneError(ctx.userId, "sync.listConversations", page.error));
    }
    const plain = page.value.conversations.map(GMConversation.toPlain);
    const upserted = await Store.upsertConversations(db, ctx, plain);
    if (upserted.isErr()) return Result.err(upserted.error);
    const before = byId.size;
    for (const c of plain) byId.set(c.conversationId, c);
    const nextCursor = page.value.cursor;
    if (plain.length < want || nextCursor === undefined || byId.size === before) break;
    cursor = nextCursor;
  }
  return Result.ok({ conversations: [...byId.values()], deadlineReached: false });
};

const runSync = async (
  client: GMClient,
  db: Database,
  ctx: RcsContext,
  opts: SyncOptions,
  clock: Clock,
): Promise<Result<SyncSummary, RcsPhoneError | RcsStorageError>> => {
  const listed = await listInbox(client, db, ctx, opts.conversationCount, clock);
  if (listed.isErr()) return Result.err(listed.error);
  const conversations = listed.value.conversations;
  const synced = await Store.syncedTimestamps(
    db,
    ctx.userId,
    conversations.map((c) => c.conversationId),
  );
  if (synced.isErr()) return Result.err(synced.error);
  const targets = conversations.filter((c) => {
    const ts = synced.value.get(c.conversationId) ?? null;
    return ts === null || c.lastMessageTimestampMs > ts;
  });

  let deadlineReached = listed.value.deadlineReached;
  let conversationsSynced = 0;
  let messagesStored = 0;
  let truncated = 0;
  opts.onProgress?.({ conversationsDone: 0, conversationsTotal: targets.length });
  for (const target of targets) {
    const syncedTs = synced.value.get(target.conversationId) ?? null;
    const paged = await pageConversation(
      client,
      db,
      ctx,
      target.conversationId,
      syncedTs,
      opts,
      clock,
    );
    if (paged.isErr()) return Result.err(paged.error);
    messagesStored += paged.value.stored;
    if (paged.value.outcome === "deadline") {
      deadlineReached = true;
      break;
    }
    if (paged.value.outcome === "pageCap") truncated += 1;
    // Advance past the listed last-message time too, so a conversation whose
    // newest entry is not a fetchable message is not refetched forever.
    const boundary = Math.max(paged.value.newestTs ?? 0, target.lastMessageTimestampMs, syncedTs ?? 0);
    const marked = await Store.setSyncedTimestamp(db, ctx.userId, target.conversationId, boundary);
    if (marked.isErr()) return Result.err(marked.error);
    conversationsSynced += 1;
    opts.onProgress?.({ conversationsDone: conversationsSynced, conversationsTotal: targets.length });
  }

  return Result.ok({
    conversationsListed: conversations.length,
    conversationsToSync: targets.length,
    conversationsSynced,
    messagesStored,
    truncatedConversations: truncated,
    deadlineReached,
  });
};

const quietWindow = (clock: Clock) => {
  const remaining = clock.deadlineMs - clock.now();
  return remaining > 1_000
    ? { quietMs: 1_000, maxMs: Math.min(QUIET_BUDGET_MS, remaining - 1_000) }
    : undefined;
};

const abortedBeforeStart = (ctx: RcsContext, operation: string) =>
  new RcsAbortedError({
    userId: ctx.userId,
    operation,
    message: "The sync was cancelled before it started. Stored messages are unchanged.",
  });

export type SyncError = RcsPhoneAccessError;

/** Incremental sync of the inbox. Records the outcome in `sync_state`. */
export const syncUser = async (
  db: Database,
  ctx: RcsContext,
  opts: SyncOptions,
): Promise<Result<SyncSummary, SyncError>> => {
  const clock: Clock = { now: opts.now ?? Date.now, deadlineMs: opts.deadlineMs, signal: opts.signal };
  if (expired(clock)) return Result.err(abortedBeforeStart(ctx, "sync"));
  const result = await withPhone(db, ctx, (client) => runSync(client, db, ctx, opts, clock), {
    operation: "sync",
    signal: opts.signal,
    waitForQuiet: quietWindow(clock),
    ...opts.phone,
  });
  // Busy (another invocation is syncing) and cancelled runs are not sync failures.
  const recorded = result.isOk()
    ? await SyncState.recordSuccess(db, ctx.userId, new Date(clock.now()))
    : result.error._tag === "RcsPhoneBusyError" || result.error._tag === "RcsAbortedError"
      ? Result.ok(undefined)
      : await SyncState.recordFailure(db, ctx.userId, describePhoneError(result.error));
  if (recorded.isErr()) {
    console.warn(`[rcs:sync] recording sync state failed: ${describeForLog(recorded.error)}`);
  }
  return result;
};

/** The larger first sync right after pairing; anything left over syncs incrementally later. */
export const backfill = (
  db: Database,
  ctx: RcsContext,
  opts: Omit<SyncOptions, keyof SyncLimits> & { readonly limits?: SyncLimits },
): Promise<Result<SyncSummary, SyncError>> => {
  const { limits, ...rest } = opts;
  return syncUser(db, ctx, { ...(limits ?? SyncLimits.backfill), ...rest });
};

export type ConversationSyncSummary = {
  readonly messagesStored: number;
  readonly outcome: PagingOutcome;
};

/** Sync one conversation (newest pages back to what is stored), e.g. before reading it. */
export const syncConversation = async (
  db: Database,
  ctx: RcsContext,
  conversationId: string,
  opts: Pick<SyncLimits, "messagesPerPage" | "maxPagesPerConversation"> & {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    readonly phone?: WithPhoneOptions;
    readonly now?: () => number;
  },
): Promise<Result<ConversationSyncSummary, SyncError>> => {
  const clock: Clock = { now: opts.now ?? Date.now, deadlineMs: opts.deadlineMs, signal: opts.signal };
  if (expired(clock)) return Result.err(abortedBeforeStart(ctx, "syncConversation"));
  return withPhone(
    db,
    ctx,
    async (client): Promise<Result<ConversationSyncSummary, RcsPhoneError | RcsStorageError>> => {
      const known = await Store.syncedTimestamps(db, ctx.userId, [conversationId]);
      if (known.isErr()) return Result.err(known.error);
      if (!known.value.has(conversationId)) {
        const fetched = await client.getConversation(conversationId);
        if (fetched.isErr()) {
          return Result.err(
            GmFailure.toPhoneError(ctx.userId, "syncConversation.getConversation", fetched.error),
          );
        }
        const upserted = await Store.upsertConversations(db, ctx, [
          GMConversation.toPlain(fetched.value),
        ]);
        if (upserted.isErr()) return Result.err(upserted.error);
      }
      const syncedTs = known.value.get(conversationId) ?? null;
      const paged = await pageConversation(client, db, ctx, conversationId, syncedTs, opts, clock);
      if (paged.isErr()) return Result.err(paged.error);
      if (paged.value.outcome !== "deadline" && paged.value.newestTs !== null) {
        const boundary = Math.max(paged.value.newestTs, syncedTs ?? 0);
        const marked = await Store.setSyncedTimestamp(db, ctx.userId, conversationId, boundary);
        if (marked.isErr()) return Result.err(marked.error);
      }
      return Result.ok({ messagesStored: paged.value.stored, outcome: paged.value.outcome });
    },
    { operation: "syncConversation", signal: opts.signal, waitForQuiet: quietWindow(clock), ...opts.phone },
  );
};

export type Freshness =
  /** Synced recently enough; nothing was fetched. */
  | { readonly status: "fresh"; readonly lastSyncAt: Date }
  /** Just synced. */
  | { readonly status: "synced"; readonly lastSyncAt: Date; readonly summary: SyncSummary }
  /** Could not sync; cached data is still usable. `reason` is plain text. */
  | {
      readonly status: "stale";
      readonly lastSyncAt: Date | null;
      readonly reason: string;
      readonly needsRepair: boolean;
    };

const isRepairError = (error: SyncError): boolean =>
  error._tag === "RcsNeedsRepairError" || (error._tag === "RcsPhoneError" && error.needsRepair);

/**
 * Sync only if the last successful sync is older than `maxAgeMs`. A phone that
 * cannot be reached is not an error: the cached data stays usable and the
 * result says how stale it is and why.
 */
export const ensureFresh = async (
  db: Database,
  ctx: RcsContext,
  opts: {
    readonly maxAgeMs: number;
    readonly deadlineMs: number;
    readonly limits?: SyncLimits;
    readonly signal?: AbortSignal;
    readonly phone?: WithPhoneOptions;
    readonly now?: () => number;
  },
): Promise<Result<Freshness, RcsStorageError>> => {
  const now = opts.now ?? Date.now;
  const state = await SyncState.read(db, ctx.userId);
  if (state.isErr()) return Result.err(state.error);
  const lastSyncAt = state.value.lastSyncAt;
  if (lastSyncAt !== null && now() - lastSyncAt.getTime() < opts.maxAgeMs) {
    return Result.ok({ status: "fresh", lastSyncAt });
  }
  const synced = await syncUser(db, ctx, {
    ...(opts.limits ?? SyncLimits.incremental),
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
    phone: opts.phone,
    now,
  });
  return Result.ok(
    synced.match<Freshness>({
      ok: (summary) => ({ status: "synced", lastSyncAt: new Date(now()), summary }),
      err: (error) => ({
        status: "stale",
        lastSyncAt,
        reason: describePhoneError(error),
        needsRepair: isRepairError(error),
      }),
    }),
  );
};

export const Sync = { syncUser, backfill, syncConversation, ensureFresh, limits: SyncLimits } as const;

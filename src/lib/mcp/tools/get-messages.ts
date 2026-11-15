import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { describePhoneError } from "@/lib/rcs/phone";
import { Store, type StoredMessage } from "@/lib/rcs/store";
import { syncConversation } from "@/lib/rcs/sync";
import { SyncState } from "@/lib/rcs/sync-state";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  clip,
  dashboardUrl,
  fail,
  FreshnessSchema,
  freshnessLine,
  iso,
  isCallToolResult,
  logToolError,
  ok,
  requireSession,
  skippedFreshness,
  TOOL_LEASE_WAIT_MS,
  TOOL_SYNC_BUDGET_MS,
  type FreshnessOutput,
} from "./shared";

const MAX_LIMIT = 200;

const inputSchema = z.object({
  conversation_id: z.string().min(1).max(200).describe("Conversation id from list_conversations."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many messages to return (1-${MAX_LIMIT}, default 30): the newest ones, or the newest before \`before\`.`),
  before: z
    .string()
    .max(64)
    .optional()
    .describe(
      "ISO 8601 timestamp (e.g. 2026-11-05T18:30:00Z). Only messages strictly older are returned; pass the previous page's next_before to page back.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe("Fetch this conversation's newest messages from the phone first (default true; skipped when `before` is set)."),
});

export const MessageSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  sent_at: z.iso.datetime(),
  from_me: z.boolean(),
  sender_name: z.string().nullable(),
  sender_number: z.string().nullable(),
  text: z.string(),
  status: z.string(),
  reply_to_message_id: z.string().nullable(),
  media: z
    .object({ media_id: z.string(), mime_type: z.string(), name: z.string(), size: z.number() })
    .nullable(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
});

const outputSchema = z.object({
  conversation: z.object({ conversation_id: z.string(), name: z.string().nullable() }),
  /** Oldest first. */
  messages: z.array(MessageSchema),
  /** Pass as `before` to get the previous page; null when this page is empty. */
  next_before: z.iso.datetime().nullable(),
  freshness: FreshnessSchema,
});

export const messageOutput = (m: StoredMessage): z.infer<typeof MessageSchema> => ({
  message_id: m.messageId,
  conversation_id: m.conversationId,
  sent_at: iso(m.timestampMs),
  from_me: m.fromMe,
  sender_name: m.senderName,
  sender_number: m.senderNumber,
  text: m.body,
  status: m.status,
  reply_to_message_id: m.replyToId,
  media:
    m.media === null
      ? null
      : { media_id: m.media.mediaId, mime_type: m.media.mimeType, name: m.media.name, size: m.media.size },
  reactions: m.reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
});

/** One compact line per message for the text content. */
export const messageLine = (m: z.infer<typeof MessageSchema>): string => {
  const who = m.from_me ? "me" : (m.sender_name ?? m.sender_number ?? "them");
  const media = m.media === null ? "" : ` [${m.media.mime_type}${m.media.name ? ` ${m.media.name}` : ""}]`;
  return `[${m.sent_at}] ${who}: ${clip(m.text, 500)}${media} (id ${m.message_id})`;
};

const parseBefore = (value: string | undefined): number | undefined | null => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

export const registerGetMessagesTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_messages",
    {
      title: "Get messages",
      description:
        "Returns messages of one conversation in chat order (oldest first), newest page by default. Use conversation_id from list_conversations. Page back with `before` = the previous result's next_before. Timestamps are ISO 8601 UTC. By default fetches the conversation's newest messages from the phone first; if the phone is unreachable it answers from stored messages and says so.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ conversation_id, limit, before, refresh }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const beforeMs = parseBefore(before);
      if (beforeMs === null) {
        return fail(`before must be an ISO 8601 timestamp such as 2026-11-05T18:30:00Z (got "${before}").`);
      }
      const db = getDb();
      const session = await requireSession(db, ctx, "get_messages");
      if (isCallToolResult(session)) return session;
      const rcs = session.rcs;

      let freshness: FreshnessOutput;
      const state = await SyncState.read(db, ctx.auth.userId);
      const lastSyncAt = state.isOk() ? state.value.lastSyncAt : null;
      if (beforeMs !== undefined || refresh === false) {
        freshness = skippedFreshness(lastSyncAt, "Showing stored messages (no refresh requested).");
      } else if (session.record.status !== "paired") {
        freshness = skippedFreshness(
          lastSyncAt,
          `Showing stored messages: the phone needs re-pairing (ask the user to pair again at ${dashboardUrl()}).`,
        );
      } else {
        const synced = await syncConversation(db, rcs, conversation_id, {
          messagesPerPage: 30,
          maxPagesPerConversation: 2,
          deadlineMs: Date.now() + TOOL_SYNC_BUDGET_MS,
          phone: { lease: { waitMs: TOOL_LEASE_WAIT_MS } },
        });
        if (synced.isOk()) {
          freshness = { status: "synced", last_sync_at: new Date().toISOString(), note: null };
        } else {
          console.warn(`[mcp:get_messages] refresh failed: ${describeForLog(synced.error)}`);
          freshness = {
            status: "stale",
            last_sync_at: lastSyncAt === null ? null : lastSyncAt.toISOString(),
            note: `Showing stored messages; could not fetch new ones from the phone: ${describePhoneError(synced.error)}`,
          };
        }
      }

      const [page, conversation] = await Promise.all([
        Store.getMessages(db, rcs, conversation_id, { limit: limit ?? 30, beforeMs }),
        Store.getConversation(db, rcs, conversation_id),
      ]);
      if (page.isErr()) {
        logToolError("get_messages", page.error);
        return fail(page.error.message);
      }
      const name = conversation.isOk() ? (conversation.value?.name ?? null) : null;
      const messages = page.value.messages.map(messageOutput);
      const first = page.value.messages[0];
      const output: z.infer<typeof outputSchema> = {
        conversation: { conversation_id, name },
        messages,
        next_before: first === undefined ? null : iso(first.timestampMs),
        freshness,
      };
      const header =
        messages.length === 0
          ? `No stored messages in conversation ${conversation_id}${beforeMs === undefined ? "" : " before that time"}. Check the id with list_conversations.`
          : `${messages.length} message(s) in ${name ?? conversation_id}, oldest first:`;
      const unreadable =
        page.value.unreadable > 0
          ? [`${page.value.unreadable} stored message(s) could not be decrypted and were skipped.`]
          : [];
      return ok([header, ...messages.map(messageLine), ...unreadable, freshnessLine(freshness)].join("\n"), output);
    },
  );
};

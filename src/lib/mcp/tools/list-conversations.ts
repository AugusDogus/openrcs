import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { Store, type StoredConversation } from "@/lib/rcs/store";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  clip,
  fail,
  FreshnessSchema,
  freshnessLine,
  iso,
  isCallToolResult,
  logToolError,
  ok,
  refreshBeforeRead,
  requireSession,
} from "./shared";

const inputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("How many conversations to return, newest first (1-100, default 20)."),
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Filter by conversation name, participant name or phone number (case- and accent-insensitive; all words must match).",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe("Sync with the phone first if the last sync is older than 60 s (default true)."),
});

const ConversationSchema = z.object({
  conversation_id: z.string(),
  name: z.string(),
  is_group: z.boolean(),
  participants: z.array(z.object({ name: z.string().nullable(), number: z.string().nullable() })),
  last_message_at: z.iso.datetime(),
  last_message_preview: z.string().nullable(),
  unread: z.boolean(),
});

const outputSchema = z.object({
  conversations: z.array(ConversationSchema),
  freshness: FreshnessSchema,
});

const toOutput = (c: StoredConversation): z.infer<typeof ConversationSchema> => ({
  conversation_id: c.conversationId,
  name: c.name,
  is_group: c.isGroup,
  participants: c.participants
    .filter((p) => !p.isMe)
    .map((p) => ({ name: p.name, number: p.number })),
  last_message_at: iso(c.lastMessageTimestampMs),
  last_message_preview: c.lastMessagePreview,
  unread: c.unread,
});

export const registerListConversationsTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description:
        "Lists the user's SMS/RCS conversations, most recent activity first, with each conversation_id (an opaque Google id needed by get_messages, search_messages and send_message), name, participants, last message time (ISO 8601 UTC) and preview. Use `query` to find a conversation by contact name or phone number. By default syncs with the phone first when the last sync is older than 60 s; if the phone is unreachable it answers from stored data and says so.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ limit, query, refresh }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const db = getDb();
      const session = await requireSession(db, ctx, "list_conversations");
      if (isCallToolResult(session)) return session;

      const freshness = await refreshBeforeRead(db, ctx, session, refresh ?? true, "list_conversations");
      const listed = await Store.listConversations(db, session.rcs, { limit: limit ?? 20, query });
      if (listed.isErr()) {
        if (listed.error._tag === "SearchQueryError") return fail(listed.error.message);
        logToolError("list_conversations", listed.error);
        return fail(listed.error.message);
      }
      const conversations = listed.value.conversations.map(toOutput);
      const lines = conversations.map(
        (c) =>
          `- ${c.name} [${c.conversation_id}] ${c.last_message_at}${c.unread ? " (unread)" : ""}${
            c.last_message_preview ? `: ${clip(c.last_message_preview, 80)}` : ""
          }`,
      );
      const header =
        conversations.length === 0
          ? query
            ? `No stored conversations match "${query}".`
            : "No conversations are stored yet."
          : `${conversations.length} conversation(s), newest first:`;
      const unreadable =
        listed.value.unreadable > 0
          ? [`${listed.value.unreadable} stored conversation(s) could not be decrypted and were skipped.`]
          : [];
      return ok([header, ...lines, ...unreadable, freshnessLine(freshness)].join("\n"), {
        conversations,
        freshness,
      });
    },
  );
};

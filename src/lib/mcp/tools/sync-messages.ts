import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { describePhoneError } from "@/lib/rcs/phone";
import { syncUser } from "@/lib/rcs/sync";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  fail,
  isCallToolResult,
  logToolError,
  ok,
  rcsContext,
  requirePhone,
  requireSession,
  TOOL_LEASE_WAIT_MS,
} from "./shared";

/** Leaves headroom under the MCP route's function timeout. */
const SYNC_BUDGET_MS = 80_000;
const MAX_PAGE = 50;

const inputSchema = z.object({
  conversation_count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many of the most recent conversations to check (1-100, default 25)."),
  messages_per_conversation: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("At most this many new messages to fetch per conversation (1-200, default 30)."),
});

const outputSchema = z.object({
  conversations_listed: z.number().int(),
  conversations_with_new_messages: z.number().int(),
  conversations_synced: z.number().int(),
  messages_stored: z.number().int(),
  truncated_conversations: z.number().int(),
  deadline_reached: z.boolean(),
  synced_at: z.iso.datetime(),
});

export const registerSyncMessagesTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "sync_messages",
    {
      title: "Sync messages",
      description:
        "Fetches new messages from the user's phone into openrcs now, for the most recent conversations. Read tools already sync automatically (at most once a minute), so call this only to pull more conversations or more messages per conversation than the automatic sync does. Needs the phone to be reachable; takes up to about a minute.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ conversation_count, messages_per_conversation }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const db = getDb();
      const session = await requireSession(db, ctx, "sync_messages");
      if (isCallToolResult(session)) return session;
      const offline = requirePhone(session);
      if (offline) return offline;

      const perConversation = messages_per_conversation ?? 30;
      const messagesPerPage = Math.min(perConversation, MAX_PAGE);
      const synced = await syncUser(db, rcsContext(ctx), {
        conversationCount: conversation_count ?? 25,
        messagesPerPage,
        maxPagesPerConversation: Math.ceil(perConversation / messagesPerPage),
        deadlineMs: Date.now() + SYNC_BUDGET_MS,
        phone: { lease: { waitMs: TOOL_LEASE_WAIT_MS } },
      });
      if (synced.isErr()) {
        logToolError("sync_messages", synced.error);
        return fail(`Sync failed: ${describePhoneError(synced.error)} Stored messages are unchanged and still readable.`);
      }
      const s = synced.value;
      const output: z.infer<typeof outputSchema> = {
        conversations_listed: s.conversationsListed,
        conversations_with_new_messages: s.conversationsToSync,
        conversations_synced: s.conversationsSynced,
        messages_stored: s.messagesStored,
        truncated_conversations: s.truncatedConversations,
        deadline_reached: s.deadlineReached,
        synced_at: new Date().toISOString(),
      };
      const text = [
        `Checked ${s.conversationsListed} conversation(s); ${s.conversationsToSync} had new messages, ${s.conversationsSynced} synced, ${s.messagesStored} message(s) stored.`,
        s.deadlineReached ? "Stopped at the time budget; call again to continue." : null,
        s.truncatedConversations > 0
          ? `${s.truncatedConversations} conversation(s) had more new messages than requested; raise messages_per_conversation to fetch more.`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join(" ");
      return ok(text, output);
    },
  );
};

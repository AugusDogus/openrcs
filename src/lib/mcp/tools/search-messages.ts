import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { Store } from "@/lib/rcs/store";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import { messageLine, MessageSchema, messageOutput } from "./get-messages";
import {
  fail,
  FreshnessSchema,
  freshnessLine,
  isCallToolResult,
  logToolError,
  ok,
  refreshBeforeRead,
  requireSession,
} from "./shared";

const DAY_MS = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Words to find (case- and accent-insensitive). Every word must match the message text, sender name/number or conversation name. Use "double quotes" for an exact phrase; digits match phone numbers in any format.',
    ),
  conversation_id: z.string().min(1).max(200).optional().describe("Only search this conversation (id from list_conversations)."),
  since: z.string().optional().describe("Only messages on or after this UTC date, YYYY-MM-DD."),
  until: z.string().optional().describe("Only messages on or before this UTC date, YYYY-MM-DD (inclusive)."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum hits, newest first (1-100, default 20)."),
});

const outputSchema = z.object({
  hits: z.array(MessageSchema.extend({ conversation_name: z.string().nullable() })),
  /** Messages decrypted and checked. */
  scanned: z.number().int(),
  /** Messages within the conversation/date filters. */
  total_candidates: z.number().int(),
  /** True when the scan limit stopped the search before older candidates were checked. */
  capped: z.boolean(),
  /** True when `limit` hits were found before every candidate was checked. */
  limit_reached: z.boolean(),
  freshness: FreshnessSchema,
});

/** YYYY-MM-DD (UTC) -> epoch ms at 00:00 UTC, or null when malformed. */
const parseDate = (value: string): number | null => {
  if (!datePattern.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
};

export const registerSearchMessagesTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search over the user's stored messages, newest first. Narrow with conversation_id (from list_conversations) and since/until (YYYY-MM-DD, UTC, inclusive). Messages are encrypted at rest, so the server decrypts and scans up to 20,000 of the newest candidates; the result reports how many were scanned and whether the scan was capped (if so, narrow the date range or conversation to reach older messages). Syncs with the phone first when the last sync is older than 60 s.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ query, conversation_id, since, until, limit }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const sinceMs = since === undefined ? undefined : parseDate(since);
      const untilStart = until === undefined ? undefined : parseDate(until);
      if (sinceMs === null) return fail(`since must be a date like 2026-11-01 (got "${since}").`);
      if (untilStart === null) return fail(`until must be a date like 2026-11-30 (got "${until}").`);
      const untilMs = untilStart === undefined ? undefined : untilStart + DAY_MS;
      if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        return fail("since must be on or before until.");
      }

      const db = getDb();
      const session = await requireSession(db, ctx, "search_messages");
      if (isCallToolResult(session)) return session;
      const freshness = await refreshBeforeRead(db, ctx, session, true, "search_messages");

      const searched = await Store.searchMessages(db, session.rcs, {
        query,
        conversationId: conversation_id,
        sinceMs,
        untilMs,
        limit: limit ?? 20,
      });
      if (searched.isErr()) {
        if (searched.error._tag === "SearchQueryError") return fail(searched.error.message);
        logToolError("search_messages", searched.error);
        return fail(searched.error.message);
      }
      const result = searched.value;
      const hits = result.hits.map((hit) => ({
        ...messageOutput(hit),
        conversation_name: hit.conversationName,
      }));
      const stats = `Scanned ${result.scannedCount} of ${result.totalCandidates} candidate message(s).`;
      const notes = [
        result.capped
          ? "The scan limit was reached before older messages were checked; narrow with since/until or conversation_id to search further back."
          : null,
        result.limitReached ? "More matches may exist; raise limit or narrow the search." : null,
        result.unreadable > 0 ? `${result.unreadable} message(s) could not be decrypted and were skipped.` : null,
      ].filter((note): note is string => note !== null);
      const header =
        hits.length === 0 ? `No messages match ${JSON.stringify(query)}.` : `${hits.length} match(es), newest first:`;
      const lines = hits.map((hit) => `${messageLine(hit)} in ${hit.conversation_name ?? hit.conversation_id}`);
      return ok([header, ...lines, stats, ...notes, freshnessLine(freshness)].join("\n"), {
        hits,
        scanned: result.scannedCount,
        total_candidates: result.totalCandidates,
        capped: result.capped,
        limit_reached: result.limitReached,
        freshness,
      });
    },
  );
};

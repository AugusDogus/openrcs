import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Database } from "@/lib/db/client";
import { Env } from "@/lib/env";
import type { RcsContext } from "@/lib/rcs/context";
import { describeForLog } from "@/lib/rcs/errors";
import { SessionStore, type GmSessionRecord } from "@/lib/rcs/session-store";
import { ensureFresh, type Freshness } from "@/lib/rcs/sync";
import { SyncState } from "@/lib/rcs/sync-state";
import type { RcsMcpContext } from "../context";

/** Helpers shared by the tool files: results, gating, time formats. */

/** Budget for a sync a read tool runs before answering from the cache. */
export const TOOL_SYNC_BUDGET_MS = 25_000;
/** Reads sync at most this often (tools pass it to ensureFresh). */
export const FRESHNESS_MAX_AGE_MS = 60_000;
/** How long a tool waits for another invocation to release the phone. */
export const TOOL_LEASE_WAIT_MS = 10_000;

export const rcsContext = (ctx: RcsMcpContext): RcsContext => ({
  userId: ctx.auth.userId,
  dek: ctx.auth.dek,
});

export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export const dashboardUrl = (): string =>
  Env.parseAuth(process.env).match({
    ok: (env) => `${env.BETTER_AUTH_URL}/dashboard`,
    err: () => "the openrcs dashboard",
  });

/** Successful result: compact text for the model plus validated structured content. */
export const ok = <T extends Record<string, unknown>>(text: string, structured: T): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});

export const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

export const logToolError = (tool: string, error: { readonly _tag: string }) =>
  console.error(`[mcp:${tool}] ${describeForLog(error)}`);

/**
 * The user's session metadata, or an isError result when there is nothing to
 * read (not paired) or this client's key is stale. `needs_repair` sessions
 * pass: their cached messages stay readable; tools that need the phone check
 * `status` themselves.
 */
export const requireSession = async (
  db: Database,
  ctx: RcsMcpContext,
  tool: string,
): Promise<GmSessionRecord | CallToolResult> => {
  const record = await SessionStore.readRecord(db, ctx.auth.userId);
  if (record.isErr()) {
    logToolError(tool, record.error);
    return fail(record.error.message);
  }
  const session = record.value;
  if (session === null || session.status === "unpaired") {
    return fail(
      `No phone is paired with this openrcs account yet, so there are no messages to read or send. Ask the user to open ${dashboardUrl()} and pair their phone's Google Messages, then call get_status again.`,
    );
  }
  if (session.dekId !== ctx.auth.dek.id) {
    return fail(
      "This client's authorization predates the current phone pairing, so its key cannot open the stored data. Nothing was read. Re-authorize this MCP client (disconnect and reconnect it) and approve it from the browser that paired the phone.",
    );
  }
  return session;
};

/** isError result when the session needs re-pairing (for tools that must reach the phone). */
export const requirePhone = (session: GmSessionRecord): CallToolResult | null =>
  session.status === "paired"
    ? null
    : fail(
        `Google signed openrcs out of the user's phone, so it cannot reach the phone right now. Ask the user to pair again at ${dashboardUrl()}. Stored messages are still readable with list_conversations, get_messages and search_messages (refresh is skipped).`,
      );

export const isCallToolResult = (value: GmSessionRecord | CallToolResult): value is CallToolResult =>
  "content" in value;

export const FreshnessSchema = z.object({
  status: z.enum(["fresh", "synced", "stale", "skipped"]),
  last_sync_at: z.iso.datetime().nullable(),
  note: z.string().nullable(),
});
export type FreshnessOutput = z.infer<typeof FreshnessSchema>;

export const freshnessOutput = (freshness: Freshness): FreshnessOutput => {
  switch (freshness.status) {
    case "fresh":
      return { status: "fresh", last_sync_at: freshness.lastSyncAt.toISOString(), note: null };
    case "synced":
      return {
        status: "synced",
        last_sync_at: freshness.lastSyncAt.toISOString(),
        note: freshness.summary.deadlineReached
          ? "Synced partially (time budget reached); older conversations sync on later calls."
          : null,
      };
    case "stale":
      return {
        status: "stale",
        last_sync_at: isoOrNull(freshness.lastSyncAt),
        note: `Showing stored messages; could not sync with the phone: ${freshness.reason}`,
      };
  }
};

export const skippedFreshness = (lastSyncAt: Date | null, note: string): FreshnessOutput => ({
  status: "skipped",
  last_sync_at: isoOrNull(lastSyncAt),
  note,
});

/** One line for the text content describing data freshness. */
export const freshnessLine = (freshness: FreshnessOutput): string => {
  const when = freshness.last_sync_at === null ? "never synced" : `last synced ${freshness.last_sync_at}`;
  return freshness.note === null ? `(${when})` : `(${when}. ${freshness.note})`;
};

/** Collapse whitespace and cut long text for compact listings. */
export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * Sync first when asked and possible (paired, last sync older than 60 s),
 * otherwise report why the answer comes from the cache. Never fails: cached
 * data stays usable when the phone cannot be reached.
 */
export const refreshBeforeRead = async (
  db: Database,
  ctx: RcsMcpContext,
  session: GmSessionRecord,
  refresh: boolean,
  tool: string,
): Promise<FreshnessOutput> => {
  if (!refresh || session.status !== "paired") {
    const state = await SyncState.read(db, ctx.auth.userId);
    const lastSyncAt = state.isOk() ? state.value.lastSyncAt : null;
    return skippedFreshness(
      lastSyncAt,
      refresh
        ? `Showing stored data: the phone needs re-pairing (ask the user to pair again at ${dashboardUrl()}).`
        : "Showing stored data (refresh=false).",
    );
  }
  const fresh = await ensureFresh(db, rcsContext(ctx), {
    maxAgeMs: FRESHNESS_MAX_AGE_MS,
    deadlineMs: Date.now() + TOOL_SYNC_BUDGET_MS,
    phone: { lease: { waitMs: TOOL_LEASE_WAIT_MS } },
  });
  if (fresh.isErr()) {
    logToolError(tool, fresh.error);
    return skippedFreshness(null, `Showing stored data: ${fresh.error.message}`);
  }
  return freshnessOutput(fresh.value);
};

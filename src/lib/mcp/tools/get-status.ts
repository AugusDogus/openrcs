import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GM_SESSION_KINDS, GM_SESSION_STATUSES } from "@/lib/db/app-schema";
import { getDb } from "@/lib/db/client";
import { SessionStore } from "@/lib/rcs/session-store";
import { Store } from "@/lib/rcs/store";
import { SyncState } from "@/lib/rcs/sync-state";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import { dashboardUrl, fail, isoOrNull, logToolError, ok } from "./shared";

const outputSchema = z.object({
  pairing: z.object({
    status: z.enum([...GM_SESSION_STATUSES]),
    kind: z.enum([...GM_SESSION_KINDS]).nullable(),
    phone_label: z.string().nullable(),
    last_connected_at: z.iso.datetime().nullable(),
    last_error: z.string().nullable(),
  }),
  sync: z.object({
    last_sync_at: z.iso.datetime().nullable(),
    last_sync_error: z.string().nullable(),
  }),
  stored: z.object({ conversations: z.number().int(), messages: z.number().int() }),
  scopes: z.array(z.string()),
  dashboard_url: z.string(),
});

const nextStep = (status: z.infer<typeof outputSchema>["pairing"]["status"]) => {
  if (status === "unpaired") return `Not paired: ask the user to pair their phone at ${dashboardUrl()}.`;
  if (status === "needs_repair") {
    return `Needs re-pairing: ask the user to pair again at ${dashboardUrl()}. Stored messages are still readable.`;
  }
  return "Ready: use list_conversations to find conversation ids.";
};

export const registerGetStatusTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_status",
    {
      title: "Get status",
      description:
        "Call this first. Reports whether the user's phone (Google Messages) is paired with openrcs (status paired, needs_repair or unpaired), when it last connected and synced, how many conversations and messages are stored, and which scopes this client has. If status is not 'paired', tell the user to pair (or re-pair) in the openrcs dashboard. Timestamps are ISO 8601 UTC.",
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      if (ctx.auth.scopes.length === 0) {
        return ToolScope.check(ctx, ToolScope.read) ?? fail("This client has no message scopes.");
      }
      const db = getDb();
      const userId = ctx.auth.userId;
      const [record, sync, counts] = await Promise.all([
        SessionStore.readRecord(db, userId),
        SyncState.read(db, userId),
        Store.counts(db, userId),
      ]);
      const storageFailure = (error: { readonly _tag: string }) => {
        logToolError("get_status", error);
        return fail(
          "Could not read the openrcs status because the database did not respond. Nothing was changed; try again in a moment.",
        );
      };
      if (record.isErr()) return storageFailure(record.error);
      if (sync.isErr()) return storageFailure(sync.error);
      if (counts.isErr()) return storageFailure(counts.error);
      const session = record.value;
      const status = session?.status ?? "unpaired";
      const output: z.infer<typeof outputSchema> = {
        pairing: {
          status,
          kind: session?.kind ?? null,
          phone_label: session?.phoneLabel ?? null,
          last_connected_at: isoOrNull(session?.lastConnectedAt ?? null),
          last_error: session?.lastError ?? null,
        },
        sync: {
          last_sync_at: isoOrNull(sync.value.lastSyncAt),
          last_sync_error: sync.value.lastSyncError,
        },
        stored: counts.value,
        scopes: [...ctx.auth.scopes],
        dashboard_url: dashboardUrl(),
      };
      const text = [
        `Phone: ${status}${session?.phoneLabel ? ` (${session.phoneLabel})` : ""}.`,
        `Last synced: ${output.sync.last_sync_at ?? "never"}.`,
        `Stored: ${counts.value.conversations} conversations, ${counts.value.messages} messages.`,
        `Scopes: ${output.scopes.join(", ")}.`,
        nextStep(status),
      ].join(" ");
      return ok(text, output);
    },
  );
};

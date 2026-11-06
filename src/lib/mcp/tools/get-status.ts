import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GM_SESSION_KINDS, GM_SESSION_STATUSES } from "@/lib/db/app-schema";
import { getDb } from "@/lib/db/client";
import { PairingStatus } from "@/lib/db/pairing-status";
import type { RcsToolRegistrar } from "@/lib/mcp/context";

const outputSchema = z.object({
  userId: z.string(),
  status: z.enum([...GM_SESSION_STATUSES]),
  kind: z.enum([...GM_SESSION_KINDS]).nullable(),
  phoneLabel: z.string().nullable(),
  lastConnectedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});

type StatusOutput = z.infer<typeof outputSchema>;

const toOutput = (userId: string, status: PairingStatus): StatusOutput => ({
  userId,
  status: status.status,
  kind: status.kind,
  phoneLabel: status.phoneLabel,
  lastConnectedAt: status.lastConnectedAt?.toISOString() ?? null,
  lastError: status.lastError,
});

export const registerGetStatusTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_status",
    {
      title: "Get pairing status",
      description:
        "Returns the signed-in openrcs user id and whether their phone's Google Messages is paired. Call this first: if status is not 'paired', ask the user to pair their phone in the openrcs dashboard.",
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const result = await PairingStatus.read(getDb(), ctx.userId);
      return result.match<CallToolResult>({
        ok: (status) => {
          const output = toOutput(ctx.userId, status);
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        },
        err: (error) => {
          console.error(`[mcp:get_status] ${error.message}`, error.cause);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Could not read the phone pairing status. Nothing was changed. Try again in a moment; if it keeps failing, the openrcs server's database connection needs attention.",
              },
            ],
          };
        },
      });
    },
  );
};

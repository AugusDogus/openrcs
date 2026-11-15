import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { z } from "zod";
import type { Contact } from "@/gen/gmproto/conversations_pb";
import { getDb } from "@/lib/db/client";
import { GmFailure } from "@/lib/rcs/errors";
import { describePhoneError, withPhone } from "@/lib/rcs/phone";
import { SearchQuery } from "@/lib/rcs/search-query";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  fail,
  isCallToolResult,
  logToolError,
  ok,
  requirePhone,
  requireSession,
  TOOL_LEASE_WAIT_MS,
} from "./shared";

const inputSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Filter by name or phone number (case- and accent-insensitive; all words must match)."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum contacts to return (1-200, default 50)."),
});

const ContactSchema = z.object({
  name: z.string(),
  number: z.string().nullable(),
  formatted_number: z.string().nullable(),
});

const outputSchema = z.object({
  contacts: z.array(ContactSchema),
  /** Contacts on the phone before filtering. */
  total: z.number().int(),
});

const toOutput = (contact: Contact): z.infer<typeof ContactSchema> => ({
  name: contact.name,
  number: contact.number?.number || null,
  formatted_number: contact.number?.formattedNumber || null,
});

export const registerListContactsTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "list_contacts",
    {
      title: "List contacts",
      description:
        "Lists contacts from the user's phone (live, not cached), optionally filtered by name or number. Use it to find a phone number for send_message when there is no existing conversation; to message someone you already talk to, prefer the conversation_id from list_conversations. Needs the phone to be reachable.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const trimmed = query?.trim() ?? "";
      const parsed = trimmed === "" ? null : SearchQuery.parse(trimmed);
      if (parsed !== null && parsed.isErr()) return fail(parsed.error.message);
      const db = getDb();
      const session = await requireSession(db, ctx, "list_contacts");
      if (isCallToolResult(session)) return session;
      const offline = requirePhone(session);
      if (offline) return offline;

      const userId = ctx.auth.userId;
      const listed = await withPhone(
        db,
        session.rcs,
        async (client) => {
          const response = await client.listContacts();
          return response.isOk()
            ? Result.ok(response.value.contacts)
            : Result.err(GmFailure.toPhoneError(userId, "listContacts", response.error));
        },
        { operation: "listContacts", lease: { waitMs: TOOL_LEASE_WAIT_MS } },
      );
      if (listed.isErr()) {
        logToolError("list_contacts", listed.error);
        return fail(`Could not load contacts from the phone: ${describePhoneError(listed.error)}`);
      }
      const all = listed.value;
      const filter = parsed?.isOk() ? parsed.value : null;
      const matching = all
        .filter(
          (contact) =>
            filter === null ||
            SearchQuery.matches(filter, {
              text: [contact.name, contact.number?.number ?? null, contact.number?.formattedNumber ?? null],
              numbers: [contact.number?.number ?? null],
            }),
        )
        .slice(0, limit ?? 50)
        .map(toOutput);
      const lines = matching.map((c) => `- ${c.name}: ${c.formatted_number ?? c.number ?? "(no number)"}`);
      const header =
        matching.length === 0
          ? filter === null
            ? "The phone returned no contacts."
            : `No contacts match ${JSON.stringify(trimmed)} (of ${all.length}).`
          : `${matching.length} contact(s)${filter === null ? "" : ` matching ${JSON.stringify(trimmed)}`} of ${all.length}:`;
      return ok([header, ...lines].join("\n"), { contacts: matching, total: all.length });
    },
  );
};

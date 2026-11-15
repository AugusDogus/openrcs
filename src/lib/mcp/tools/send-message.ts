import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { describePhoneError } from "@/lib/rcs/phone";
import { MAX_TEXT_LENGTH, SendRequest, sendText } from "@/lib/rcs/send";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  fail,
  iso,
  isCallToolResult,
  logToolError,
  ok,
  requirePhone,
  requireSession,
  TOOL_LEASE_WAIT_MS,
} from "./shared";

const inputSchema = z.object({
  conversation_id: z
    .string()
    .max(200)
    .optional()
    .describe("Existing conversation to send to (id from list_conversations). Give this or phone_number, not both."),
  phone_number: z
    .string()
    .max(32)
    .optional()
    .describe("Recipient phone number with country code, e.g. +15551234567, for a one-to-one message. Not a contact name."),
  text: z.string().max(MAX_TEXT_LENGTH * 4).describe(`Message text (non-empty, at most ${MAX_TEXT_LENGTH} characters).`),
  reply_to_message_id: z
    .string()
    .max(200)
    .optional()
    .describe("Optional message_id (from get_messages) to reply to within the same conversation."),
});

const outputSchema = z.object({
  conversation_id: z.string(),
  conversation_name: z.string(),
  /** Temporary id until the phone reports the delivered message. */
  message_id: z.string(),
  sent_at: z.iso.datetime(),
  status: z.string(),
});

export const registerSendMessageTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Sends an SMS/RCS text from the user's phone. Target exactly one of conversation_id (preferred; from list_conversations) or phone_number (with country code, e.g. +15551234567). Confirm the recipient and text with the user before sending. If the result says the phone did not confirm in time, the message may still be delivered: check get_messages before retrying, never resend blindly.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.send),
    },
    async ({ conversation_id, phone_number, text, reply_to_message_id }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.send);
      if (denied) return denied;
      const request = SendRequest.parse({
        conversationId: conversation_id,
        phoneNumber: phone_number,
        text,
        replyToMessageId: reply_to_message_id,
      });
      if (request.isErr()) return fail(request.error.message);

      const db = getDb();
      const session = await requireSession(db, ctx, "send_message");
      if (isCallToolResult(session)) return session;
      const offline = requirePhone(session);
      if (offline) return offline;

      const sent = await sendText(db, session.rcs, request.value, {
        phone: { lease: { waitMs: TOOL_LEASE_WAIT_MS } },
      });
      if (sent.isErr()) {
        logToolError("send_message", sent.error);
        return fail(describePhoneError(sent.error));
      }
      const message = sent.value;
      return ok(`Sent to ${message.conversationName} [${message.conversationId}] at ${iso(message.timestampMs)} (status ${message.status}).`, {
        conversation_id: message.conversationId,
        conversation_name: message.conversationName,
        message_id: message.messageId,
        sent_at: iso(message.timestampMs),
        status: message.status,
      });
    },
  );
};

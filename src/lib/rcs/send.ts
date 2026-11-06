import { create } from "@bufbuild/protobuf";
import { Result, TaggedError } from "better-result";
import {
  GetOrCreateConversationRequestSchema,
  GetOrCreateConversationResponse_Status,
  SendMessageResponse_Status,
} from "@/gen/gmproto/client_pb";
import type { Conversation } from "@/gen/gmproto/conversations_pb";
import type { Database } from "@/lib/db/client";
import type { GMClient } from "@/lib/gm/client";
import { GMConversation, SendPayload } from "@/lib/gm/message";
import type { RcsContext } from "./context";
import { describeForLog, GmFailure, type RcsPhoneAccessError, type RcsPhoneError } from "./errors";
import { withPhone, type WithPhoneOptions } from "./phone";
import { Store } from "./store";

/** Longest text accepted, in Unicode code points. */
export const MAX_TEXT_LENGTH = 2_000;

export type SendTarget =
  | { readonly kind: "conversation"; readonly conversationId: string }
  | { readonly kind: "phoneNumber"; readonly phoneNumber: string };

export type SendRequest = {
  readonly target: SendTarget;
  readonly text: string;
  readonly replyToMessageId: string | null;
};

/** The request is malformed; nothing was sent. */
export class SendValidationError extends TaggedError("SendValidationError")<{
  field: string;
  message: string;
}> {}

/** The conversation could not be found or created; nothing was sent. */
export class SendTargetError extends TaggedError("SendTargetError")<{
  userId: string;
  reason: string;
  message: string;
}> {}

/** Google Messages answered the send with a non-success status; nothing was sent. */
export class SendRejectedError extends TaggedError("SendRejectedError")<{
  userId: string;
  status: string;
  message: string;
}> {}

/** The phone did not confirm in time. The message may still be delivered: do not retry blindly. */
export class SendUnconfirmedError extends TaggedError("SendUnconfirmedError")<{
  userId: string;
  conversationId: string;
  message: string;
}> {}

export type SendError =
  | SendValidationError
  | SendTargetError
  | SendRejectedError
  | SendUnconfirmedError
  | RcsPhoneAccessError;

export type SentMessage = {
  readonly conversationId: string;
  readonly conversationName: string;
  /** Temporary id until the phone reports the real one (then the stored row is replaced). */
  readonly messageId: string;
  readonly timestampMs: number;
  readonly status: string;
};

const digitsOnly = (value: string) => value.replace(/\D+/g, "");

/**
 * Plausible E.164-style number: 7-15 digits and no letters. Names like "Mom"
 * are rejected because Google would resolve them against the address book and
 * could pick the wrong contact.
 */
const looksLikePhoneNumber = (value: string): boolean => {
  if (/\p{L}/u.test(value)) return false;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = digitsOnly(value).length;
  return digits >= 7 && digits <= 15;
};

const invalid = (field: string, message: string) =>
  Result.err(new SendValidationError({ field, message }));

const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Validate raw input: exactly one target, non-empty text within MAX_TEXT_LENGTH. */
const parse = (input: {
  readonly conversationId?: string;
  readonly phoneNumber?: string;
  readonly text: string;
  readonly replyToMessageId?: string;
}): Result<SendRequest, SendValidationError> => {
  const conversationId = blankToNull(input.conversationId);
  const phoneNumber = blankToNull(input.phoneNumber);
  if ((conversationId === null) === (phoneNumber === null)) {
    return invalid(
      "target",
      "Pass exactly one of conversation_id (from list_conversations) or phone_number (with country code, e.g. +15551234567). Nothing was sent.",
    );
  }
  if (phoneNumber !== null && !looksLikePhoneNumber(phoneNumber)) {
    return invalid(
      "phone_number",
      "phone_number must be a phone number with country code, e.g. +15551234567 (7 to 15 digits, no names). To message a contact by name, find the conversation with list_conversations or the number with list_contacts. Nothing was sent.",
    );
  }
  if (input.text.trim() === "") {
    return invalid("text", "text is empty. Nothing was sent.");
  }
  const length = [...input.text].length;
  if (length > MAX_TEXT_LENGTH) {
    return invalid(
      "text",
      `text is ${length} characters; the limit is ${MAX_TEXT_LENGTH}. Shorten it or split it into several messages. Nothing was sent.`,
    );
  }
  const target: SendTarget =
    conversationId !== null
      ? { kind: "conversation", conversationId }
      : { kind: "phoneNumber", phoneNumber: phoneNumber ?? "" };
  return Result.ok({ target, text: input.text, replyToMessageId: blankToNull(input.replyToMessageId) });
};

const resolveConversation = async (
  client: GMClient,
  ctx: RcsContext,
  target: SendTarget,
): Promise<Result<Conversation, SendTargetError | RcsPhoneError>> => {
  if (target.kind === "conversation") {
    const fetched = await client.getConversation(target.conversationId);
    return fetched.isOk()
      ? Result.ok(fetched.value)
      : Result.err(GmFailure.toPhoneError(ctx.userId, "send.getConversation", fetched.error));
  }
  const created = await client.getOrCreateConversation(
    create(GetOrCreateConversationRequestSchema, {
      numbers: SendPayload.contactNumbers([target.phoneNumber]),
    }),
  );
  if (created.isErr()) {
    return Result.err(
      GmFailure.toPhoneError(ctx.userId, "send.getOrCreateConversation", created.error),
    );
  }
  const { status, conversation } = created.value;
  const statusName = GetOrCreateConversationResponse_Status[status] ?? String(status);
  if (status === GetOrCreateConversationResponse_Status.CREATE_RCS) {
    return Result.err(
      new SendTargetError({
        userId: ctx.userId,
        reason: statusName,
        message:
          "Google Messages asked to create a new RCS group for this number, which openrcs does not do. Nothing was sent. Start the conversation on your phone, then send to its conversation_id.",
      }),
    );
  }
  if (conversation === undefined || conversation.conversationID === "") {
    return Result.err(
      new SendTargetError({
        userId: ctx.userId,
        reason: statusName,
        message: `Google Messages did not return a conversation for that number (status ${statusName}). Nothing was sent. Check the number, or start the conversation on your phone first.`,
      }),
    );
  }
  return Result.ok(conversation);
};

const rejectedMessage = (statusName: string) =>
  `Google Messages did not accept the message (status ${statusName}). Nothing was sent. If this keeps happening, your phone may have unlinked openrcs: pair again from the dashboard, and confirm Google Messages is the phone's default SMS app.`;

/**
 * Send a text through the phone and store an optimistic outgoing message
 * (status OUTGOING_SENDING, keyed by its temp id) that the phone's echo
 * replaces when it arrives.
 */
export const sendText = (
  db: Database,
  ctx: RcsContext,
  request: SendRequest,
  opts: { readonly phone?: WithPhoneOptions; readonly now?: () => number } = {},
): Promise<Result<SentMessage, SendError>> =>
  withPhone(
    db,
    ctx,
    async (
      client,
    ): Promise<
      Result<SentMessage, SendTargetError | SendRejectedError | SendUnconfirmedError | RcsPhoneError>
    > => {
      const resolved = await resolveConversation(client, ctx, request.target);
      if (resolved.isErr()) return Result.err(resolved.error);
      const conversation = resolved.value;
      const plainConversation = GMConversation.toPlain(conversation);
      const storedConversation = await Store.upsertConversations(db, ctx, [plainConversation]);
      if (storedConversation.isErr()) {
        console.warn(`[rcs:send] caching conversation failed: ${describeForLog(storedConversation.error)}`);
      }

      const self = GMConversation.self(conversation);
      const tmpId = SendPayload.newTmpId();
      const sent = await client.sendMessage(
        SendPayload.text({
          conversationId: conversation.conversationID,
          text: request.text,
          participantId: self.participantId,
          sim: self.sim,
          replyToId: request.replyToMessageId ?? undefined,
          tmpId,
        }),
      );
      if (sent.isErr()) {
        if (sent.error._tag === "GMPhoneNotRespondingError") {
          return Result.err(
            new SendUnconfirmedError({
              userId: ctx.userId,
              conversationId: conversation.conversationID,
              message:
                "Your phone did not confirm the send in time. The message may still be delivered, so do not resend it blindly: check the conversation's latest messages first.",
            }),
          );
        }
        return Result.err(GmFailure.toPhoneError(ctx.userId, "send.sendMessage", sent.error));
      }
      if (sent.value.status !== SendMessageResponse_Status.SUCCESS) {
        const statusName = SendMessageResponse_Status[sent.value.status] ?? String(sent.value.status);
        return Result.err(
          new SendRejectedError({ userId: ctx.userId, status: statusName, message: rejectedMessage(statusName) }),
        );
      }

      const timestampMs = (opts.now ?? Date.now)();
      const status = "OUTGOING_SENDING";
      const storedMessage = await Store.upsertMessages(db, ctx, [
        {
          messageId: tmpId,
          conversationId: conversation.conversationID,
          timestampMs,
          fromMe: true,
          senderName: null,
          senderNumber: null,
          body: request.text,
          status,
          media: null,
          replyToId: request.replyToMessageId,
          reactions: [],
          tmpId,
        },
      ]);
      if (storedMessage.isErr()) {
        console.warn(`[rcs:send] storing the sent message failed: ${describeForLog(storedMessage.error)}`);
      }
      return Result.ok({
        conversationId: conversation.conversationID,
        conversationName: plainConversation.name,
        messageId: tmpId,
        timestampMs,
        status,
      });
    },
    { operation: "send", waitForQuiet: { quietMs: 1_500, maxMs: 4_000 }, ...opts.phone },
  );

export const SendRequest = { parse, looksLikePhoneNumber } as const;

import { randomInt } from "node:crypto";
import { create } from "@bufbuild/protobuf";

import { SendMessageRequestSchema, type SendMessageRequest } from "@/gen/gmproto/client_pb";
import {
  ContactNumberSchema,
  ConversationStatus,
  MediaFormats,
  MessageStatusType,
  type ContactNumber,
  type Conversation,
  type Message,
} from "@/gen/gmproto/conversations_pb";
import type { SIMPayload } from "@/gen/gmproto/settings_pb";

// Port of openmessage internal/client/client.go extraction helpers
// (ExtractMessageBody, ExtractMediaInfo, ExtractReactions, ExtractReplyToID,
// ExtractSenderInfo, MessageIsFromMe) and internal/app/gm.go payload builders
// (ExtractSIMAndParticipant, BuildSendPayloadWithTmpID, NewContactNumbers).

export type PlainMedia = {
  mediaId: string;
  mimeType: string;
  name: string;
  size: number;
  /** Base64 AES-256-GCM key that decrypts the media at `mediaId`; null when the phone sent none. Secret. */
  key: string | null;
  /** True when `mediaId` is the reduced-size preview because the phone has not uploaded the original. */
  thumbnail: boolean;
  /** MessageInfo.actionMessageID of this part, needed to ask the phone for the original. */
  partId: string | null;
};
export type PlainReaction = { emoji: string; count: number; participantIds: string[] };
export type PlainMessage = {
  messageId: string;
  conversationId: string;
  timestampMs: number;
  fromMe: boolean;
  senderName: string | null;
  senderNumber: string | null;
  /** Text content, "" when media-only. */
  body: string;
  /** MessageStatusType name, e.g. "OUTGOING_DELIVERED". */
  status: string;
  media: PlainMedia | null;
  replyToId: string | null;
  reactions: PlainReaction[];
  tmpId: string | null;
};
export type PlainParticipant = { participantId: string; name: string | null; number: string | null; isMe: boolean };
export type PlainConversation = {
  conversationId: string;
  name: string;
  isGroup: boolean;
  participants: PlainParticipant[];
  lastMessageTimestampMs: number;
  lastMessagePreview: string | null;
  unread: boolean;
  readOnly: boolean;
  status: string;
};

/** openmessage ContactNumberMysteriousInt. */
const CONTACT_NUMBER_MYSTERIOUS_INT = 7;

/** Protobuf microsecond timestamps to milliseconds. */
const microsToMs = (micros: bigint): number => Number(micros / 1000n);

const nonEmpty = (value: string): string | null => (value === "" ? null : value);

/** Go's enum String(): the name, or the number for unknown values. */
const enumName = (names: Record<number, string>, value: number): string => names[value] ?? String(value);

/** ExtractMessageBody: the first MessageInfo with text content. */
const extractBody = (m: Message): string => {
  for (const info of m.messageInfo) {
    if (info.data.case === "messageContent") return info.data.value.content;
  }
  return "";
};

/** ExtractMediaInfo, reduced to the PlainMedia fields. */
const extractMedia = (m: Message): PlainMedia | null => {
  for (const info of m.messageInfo) {
    if (info.data.case !== "mediaContent") continue;
    const mc = info.data.value;
    let mimeType = mc.mimeType;
    if (mimeType === "") {
      mimeType = mc.format >= MediaFormats.IMAGE_JPEG && mc.format <= 7 ? "image/jpeg" : "application/octet-stream";
    }
    // No full-size media id: fall back to the thumbnail (and its key).
    const thumbnail = mc.mediaID === "" && mc.thumbnailMediaID !== "";
    const key = thumbnail ? mc.thumbnailDecryptionKey : mc.decryptionKey;
    return {
      mediaId: thumbnail ? mc.thumbnailMediaID : mc.mediaID,
      mimeType,
      name: mc.mediaName,
      size: Number(mc.size),
      key: key.length === 0 ? null : Buffer.from(key).toString("base64"),
      thumbnail,
      partId: nonEmpty(info.actionMessageID ?? ""),
    };
  }
  return null;
};

/** ExtractReactions (empty list instead of nil). */
const extractReactions = (m: Message): PlainReaction[] => {
  const reactions: PlainReaction[] = [];
  for (const entry of m.reactions) {
    const emoji = entry.data?.unicode ?? "";
    if (entry.data === undefined || emoji === "") continue;
    reactions.push({ emoji, count: entry.participantIDs.length, participantIds: [...entry.participantIDs] });
  }
  return reactions;
};

/** ExtractSenderInfo. */
const extractSender = (m: Message): { name: string; number: string } => {
  const p = m.senderParticipant;
  if (p === undefined) return { name: "", number: "" };
  const name = p.fullName !== "" ? p.fullName : p.firstName;
  const idNumber = p.ID?.number ?? "";
  return { name, number: idNumber !== "" ? idNumber : p.formattedNumber };
};

/** MessageIsFromMe. */
const isFromMe = (m: Message): boolean => {
  if (m.senderParticipant?.isMe === true) return true;
  if (m.messageStatus !== undefined) return enumName(MessageStatusType, m.messageStatus.status).startsWith("OUTGOING");
  return false;
};

export const GMMessage = {
  toPlain(m: Message): PlainMessage {
    const sender = extractSender(m);
    return {
      messageId: m.messageID,
      conversationId: m.conversationID,
      timestampMs: microsToMs(m.timestamp),
      fromMe: isFromMe(m),
      senderName: nonEmpty(sender.name),
      senderNumber: nonEmpty(sender.number),
      body: extractBody(m),
      status: enumName(MessageStatusType, m.messageStatus?.status ?? MessageStatusType.STATUS_UNKNOWN),
      media: extractMedia(m),
      replyToId: nonEmpty(m.replyMessage?.messageID ?? ""),
      reactions: extractReactions(m),
      tmpId: nonEmpty(m.tmpID),
    };
  },
} as const;

export const GMConversation = {
  toPlain(c: Conversation): PlainConversation {
    return {
      conversationId: c.conversationID,
      name: c.name,
      isGroup: c.isGroupChat,
      participants: c.participants.map((p) => ({
        participantId: p.ID?.participantID ?? "",
        name: nonEmpty(p.fullName !== "" ? p.fullName : p.firstName),
        number: nonEmpty((p.ID?.number ?? "") !== "" ? (p.ID?.number ?? "") : p.formattedNumber),
        isMe: p.isMe,
      })),
      lastMessageTimestampMs: microsToMs(c.lastMessageTimestamp),
      lastMessagePreview: nonEmpty(c.latestMessage?.displayContent ?? ""),
      unread: c.unread,
      readOnly: c.readOnly,
      status: enumName(ConversationStatus, c.status),
    };
  },

  /** ExtractSIMAndParticipant: our participant id + SIM payload, falling back to the conversation SIM card. */
  self(c: Conversation): { participantId: string; sim: SIMPayload | null } {
    let participantId = "";
    let sim: SIMPayload | null = null;
    const me = c.participants.find((p) => p.isMe);
    if (me !== undefined) {
      participantId = me.ID?.number ?? "";
      sim = me.simPayload ?? null;
    }
    if (sim === null) sim = c.simCard?.SIMData?.SIMPayload ?? null;
    return { participantId, sim };
  },
} as const;

/** openmessage newSendTmpID: a trimmed preferred id, else "tmp_" + 12 random digits. */
const tmpIdFor = (preferred: string | undefined): string => {
  const trimmed = preferred?.trim() ?? "";
  return trimmed !== "" ? trimmed : SendPayload.newTmpId();
};

export const SendPayload = {
  /** BuildSendPayloadWithTmpID: MessageInfo array, the tmp id in three places, SIM and participant. */
  text(opts: {
    conversationId: string;
    text: string;
    participantId: string;
    sim: SIMPayload | null;
    replyToId?: string;
    tmpId?: string;
  }): SendMessageRequest {
    const tmpId = tmpIdFor(opts.tmpId);
    return create(SendMessageRequestSchema, {
      conversationID: opts.conversationId,
      messagePayload: {
        tmpID: tmpId,
        messageInfo: [{ data: { case: "messageContent", value: { content: opts.text } } }],
        conversationID: opts.conversationId,
        participantID: opts.participantId,
        tmpID2: tmpId,
      },
      SIMPayload: opts.sim ?? undefined,
      tmpID: tmpId,
      reply: opts.replyToId !== undefined && opts.replyToId !== "" ? { messageID: opts.replyToId } : undefined,
    });
  },

  /** NewContactNumbers: MysteriousInt 7, Number and Number2. */
  contactNumbers(phones: string[]): ContactNumber[] {
    return phones.map((phone) =>
      create(ContactNumberSchema, { mysteriousInt: CONTACT_NUMBER_MYSTERIOUS_INT, number: phone, number2: phone }),
    );
  },

  /** "tmp_" + 12 digits (libgm GenerateTmpID format). */
  newTmpId(): string {
    return `tmp_${randomInt(0, 1_000_000_000_000).toString().padStart(12, "0")}`;
  },
} as const;

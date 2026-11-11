import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { ContactNumberSchema, ConversationSchema, MediaFormats, MessageSchema, MessageStatusType } from "@/gen/gmproto/conversations_pb";
import { SendMessageRequestSchema } from "@/gen/gmproto/client_pb";

import { GMConversation, GMMessage, SendPayload } from "./message";

describe("GMMessage.toPlain (openmessage Extract* helpers)", () => {
  const message = create(MessageSchema, {
    messageID: "m1",
    conversationID: "c1",
    timestamp: 1_762_435_299_123_456n,
    tmpID: "tmp_000000000001",
    messageInfo: [
      { data: { case: "mediaContent", value: { format: MediaFormats.IMAGE_PNG, mediaID: "", thumbnailMediaID: "thumb", mediaName: "a.png", size: 99n } } },
      { data: { case: "messageContent", value: { content: "first text" } } },
      { data: { case: "messageContent", value: { content: "second text" } } },
    ],
    messageStatus: { status: MessageStatusType.OUTGOING_DELIVERED },
    reactions: [
      { data: { unicode: "👍" }, participantIDs: ["p1", "p2"] },
      { data: { unicode: "" }, participantIDs: ["p3"] },
      { participantIDs: ["p4"] },
    ],
    replyMessage: { messageID: "m0" },
    senderParticipant: { ID: { number: "" }, firstName: "Ann", formattedNumber: "(555) 123" },
  });

  test("extracts body, media (thumbnail fallback, mime from format), reactions, reply, sender, status", () => {
    expect(GMMessage.toPlain(message)).toEqual({
      messageId: "m1",
      conversationId: "c1",
      timestampMs: 1_762_435_299_123,
      fromMe: true,
      senderName: "Ann",
      senderNumber: "(555) 123",
      body: "first text",
      status: "OUTGOING_DELIVERED",
      media: { mediaId: "thumb", mimeType: "image/jpeg", name: "a.png", size: 99, key: null, thumbnail: true, partId: null },
      replyToId: "m0",
      reactions: [{ emoji: "👍", count: 2, participantIds: ["p1", "p2"] }],
      tmpId: "tmp_000000000001",
    });
  });

  test("an empty incoming message", () => {
    const plain = GMMessage.toPlain(create(MessageSchema, { messageID: "m2", messageStatus: { status: MessageStatusType.INCOMING_COMPLETE } }));
    expect(plain).toMatchObject({ fromMe: false, body: "", media: null, replyToId: null, reactions: [], tmpId: null, senderName: null, senderNumber: null, status: "INCOMING_COMPLETE" });
  });

  test("isMe wins over status; no status and no sender is not from me", () => {
    expect(GMMessage.toPlain(create(MessageSchema, { senderParticipant: { isMe: true } })).fromMe).toBe(true);
    expect(GMMessage.toPlain(create(MessageSchema, {})).fromMe).toBe(false);
  });
});

describe("GMConversation", () => {
  const conversation = create(ConversationSchema, {
    conversationID: "c1",
    name: "Group",
    isGroupChat: true,
    lastMessageTimestamp: 2_000_999n,
    unread: true,
    participants: [
      { ID: { number: "+1555", participantID: "me" }, isMe: true },
      { ID: { number: "", participantID: "p2" }, fullName: "", firstName: "Bob", formattedNumber: "(555) 2" },
    ],
    latestMessage: { displayContent: "" },
    simCard: { SIMData: { SIMPayload: { two: 2, SIMNumber: 3 } } },
  });

  test("toPlain", () => {
    expect(GMConversation.toPlain(conversation)).toEqual({
      conversationId: "c1",
      name: "Group",
      isGroup: true,
      participants: [
        { participantId: "me", name: null, number: "+1555", isMe: true },
        { participantId: "p2", name: "Bob", number: "(555) 2", isMe: false },
      ],
      lastMessageTimestampMs: 2_000,
      lastMessagePreview: null,
      unread: true,
      readOnly: false,
      status: "UNKNOWN_CONVERSATION_STATUS",
    });
  });

  test("self falls back to the conversation SIM card when our participant has none", () => {
    const self = GMConversation.self(conversation);
    expect(self.participantId).toBe("+1555");
    expect(self.sim?.SIMNumber).toBe(3);
  });
});

describe("SendPayload", () => {
  test("newTmpId is tmp_ + 12 digits; text() trims a preferred tmp id and omits an empty reply", () => {
    expect(SendPayload.newTmpId()).toMatch(/^tmp_\d{12}$/);
    const req = SendPayload.text({ conversationId: "c", text: "t", participantId: "p", sim: null, replyToId: "", tmpId: "  tmp_1  " });
    const decoded = fromBinary(SendMessageRequestSchema, toBinary(SendMessageRequestSchema, req));
    expect([decoded.tmpID, decoded.messagePayload?.tmpID, decoded.messagePayload?.tmpID2]).toEqual(["tmp_1", "tmp_1", "tmp_1"]);
    expect(decoded.reply).toBeUndefined();
    expect(decoded.SIMPayload).toBeUndefined();
  });

  test("contactNumbers", () => {
    expect(SendPayload.contactNumbers(["+1", "+2"])).toEqual([
      create(ContactNumberSchema, { mysteriousInt: 7, number: "+1", number2: "+1" }),
      create(ContactNumberSchema, { mysteriousInt: 7, number: "+2", number2: "+2" }),
    ]);
  });
});

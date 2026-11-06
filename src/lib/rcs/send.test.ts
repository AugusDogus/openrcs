import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SendMessageResponse_Status } from "@/gen/gmproto/client_pb";
import { GMPhoneNotRespondingError } from "@/lib/gm/errors";
import { MAX_TEXT_LENGTH, SendRequest, sendText } from "./send";
import { Store } from "./store";
import { RcsTesting, type RcsTestEnv } from "./testing";

describe("SendRequest.parse", () => {
  const field = (input: Parameters<typeof SendRequest.parse>[0]) => {
    const parsed = SendRequest.parse(input);
    return parsed.isErr() ? parsed.error.field : "ok";
  };

  test("requires exactly one target", () => {
    expect(field({ text: "hi" })).toBe("target");
    expect(field({ conversationId: "  ", phoneNumber: "", text: "hi" })).toBe("target");
    expect(field({ conversationId: "c1", phoneNumber: "+15551234567", text: "hi" })).toBe("target");
    expect(field({ conversationId: "c1", text: "hi" })).toBe("ok");
    expect(field({ phoneNumber: "+1 (555) 123-4567", text: "hi" })).toBe("ok");
  });

  test("rejects names and implausible numbers", () => {
    expect(field({ phoneNumber: "Mom", text: "hi" })).toBe("phone_number");
    expect(field({ phoneNumber: "John 5551234567", text: "hi" })).toBe("phone_number");
    expect(field({ phoneNumber: "12345", text: "hi" })).toBe("phone_number");
    expect(field({ phoneNumber: "+1234567890123456", text: "hi" })).toBe("phone_number");
  });

  test("requires non-empty text within the limit", () => {
    expect(field({ conversationId: "c1", text: "   \n " })).toBe("text");
    expect(field({ conversationId: "c1", text: "x".repeat(MAX_TEXT_LENGTH + 1) })).toBe("text");
    // Code points, not UTF-16 units: emoji count once.
    expect(field({ conversationId: "c1", text: "😀".repeat(MAX_TEXT_LENGTH) })).toBe("ok");
  });

  test("normalizes the target and reply id", () => {
    const parsed = SendRequest.parse({ conversationId: " c1 ", text: " hi ", replyToMessageId: "  " }).unwrap();
    expect(parsed).toEqual({ target: { kind: "conversation", conversationId: "c1" }, text: " hi ", replyToMessageId: null });
  });
});

describe("sendText", () => {
  let env: RcsTestEnv;

  beforeEach(async () => {
    env = await RcsTesting.setup();
    await RcsTesting.pair(env.db, env.ctx);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const request = (overrides: Parameters<typeof SendRequest.parse>[0]) => SendRequest.parse(overrides).unwrap();

  test("sends to a conversation and stores an optimistic outgoing message", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: 1_000 })],
    });
    const sent = (
      await sendText(env.db, env.ctx, request({ conversationId: "c1", text: "on my way" }), {
        phone: { createClient: RcsTesting.fakeClient(phone) },
      })
    ).unwrap();
    expect(sent.conversationName).toBe("Alice");
    expect(sent.messageId).toMatch(/^tmp_\d{12}$/);
    expect(phone.calls.sendMessage).toHaveLength(1);
    expect(phone.calls.sendMessage[0]?.tmpID).toBe(sent.messageId);

    const page = (await Store.getMessages(env.db, env.ctx, "c1", { limit: 5 })).unwrap();
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ body: "on my way", fromMe: true, status: "OUTGOING_SENDING", tmpId: sent.messageId });
  });

  test("resolves a phone number with getOrCreateConversation", async () => {
    const phone = RcsTesting.fakePhone();
    const sent = (
      await sendText(env.db, env.ctx, request({ phoneNumber: "+15557654321", text: "hello" }), {
        phone: { createClient: RcsTesting.fakeClient(phone) },
      })
    ).unwrap();
    expect(phone.calls.getOrCreate).toBe(1);
    expect(sent.conversationId).toBe("conv-+15557654321");
  });

  test("a phone timeout is reported as possibly delivered, not as a failure to retry", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: 1_000 })],
      sendError: new GMPhoneNotRespondingError({ action: "SEND_MESSAGE", waitedMs: 30_000, message: "timeout" }),
    });
    const result = await sendText(env.db, env.ctx, request({ conversationId: "c1", text: "hi" }), {
      phone: { createClient: RcsTesting.fakeClient(phone) },
    });
    expect(result.isErr() && result.error._tag).toBe("SendUnconfirmedError");
    expect(result.isErr() && result.error.message).toContain("may still be delivered");
    expect((await Store.getMessages(env.db, env.ctx, "c1", { limit: 5 })).unwrap().messages).toHaveLength(0);
  });

  test("a non-success status is a rejection and stores nothing", async () => {
    const phone = RcsTesting.fakePhone({
      conversations: [RcsTesting.conversation({ id: "c1", name: "Alice", lastMessageMs: 1_000 })],
      sendStatus: SendMessageResponse_Status.FAILURE_2,
    });
    const result = await sendText(env.db, env.ctx, request({ conversationId: "c1", text: "hi" }), {
      phone: { createClient: RcsTesting.fakeClient(phone) },
    });
    expect(result.isErr() && result.error._tag).toBe("SendRejectedError");
    expect(result.isErr() && result.error.message).toContain("FAILURE_2");
    expect((await Store.getMessages(env.db, env.ctx, "c1", { limit: 5 })).unwrap().messages).toHaveLength(0);
  });

  test("an unknown conversation id fails without sending", async () => {
    const phone = RcsTesting.fakePhone();
    const result = await sendText(env.db, env.ctx, request({ conversationId: "nope", text: "hi" }), {
      phone: { createClient: RcsTesting.fakeClient(phone) },
    });
    expect(result.isErr() && result.error._tag).toBe("RcsPhoneError");
    expect(phone.calls.sendMessage).toHaveLength(0);
  });
});

/**
 * Test support for the service layer: temp databases (real migrations, via
 * VaultTesting), seeded sessions, protobuf builders and a scriptable fake
 * GMClient that satisfies the src/lib/gm contract. Never imported by app code.
 */
import { create } from "@bufbuild/protobuf";
import { Result } from "better-result";
import {
  CursorSchema,
  GetOrCreateConversationResponse_Status,
  GetOrCreateConversationResponseSchema,
  ListContactsResponseSchema,
  ListConversationsResponseSchema,
  ListMessagesResponseSchema,
  ListTopContactsResponseSchema,
  SendMessageResponse_Status,
  SendMessageResponseSchema,
  SendReactionResponseSchema,
  type Cursor,
  type SendMessageRequest,
} from "@/gen/gmproto/client_pb";
import {
  ConversationSchema,
  MessageSchema,
  MessageStatusType,
  type Contact,
  type Conversation,
  type Message,
} from "@/gen/gmproto/conversations_pb";
import type { Database } from "@/lib/db/client";
import { AuthData } from "@/lib/gm/auth-data";
import type { GMClient, GMClientOptions, GMEvent } from "@/lib/gm/client";
import { GMHttpError, GMRequestError, type GMConnectError, type GMRpcError } from "@/lib/gm/errors";
import { Dek } from "@/lib/vault/dek";
import { VaultTesting } from "@/lib/vault/testing";
import type { RcsContext } from "./context";
import { SessionStore } from "./session-store";

export type RcsTestEnv = {
  readonly db: Database;
  readonly userId: string;
  readonly ctx: RcsContext;
  readonly cleanup: () => Promise<void>;
};

/** Fresh migrated DB with one user and a random DEK. */
const setup = async (): Promise<RcsTestEnv> => {
  const { db, cleanup } = await VaultTesting.createDb();
  const userId = await VaultTesting.createUser(db);
  return { db, userId, ctx: { userId, dek: Dek.generate() }, cleanup };
};

/** A paired gm_session for `ctx` (fresh AuthData, never used against Google). */
const pair = async (db: Database, ctx: RcsContext, kind: "gaia" | "qr" = "gaia") => {
  const saved = await SessionStore.save(db, ctx, {
    kind,
    phoneLabel: "Android phone (abc123)",
    authData: AuthData.createForPairing(),
  });
  if (saved.isErr()) throw saved.error;
};

const msToMicros = (ms: number): bigint => BigInt(ms) * 1000n;

const conversation = (opts: {
  id: string;
  name: string;
  lastMessageMs: number;
  number?: string;
  isGroup?: boolean;
}): Conversation =>
  create(ConversationSchema, {
    conversationID: opts.id,
    name: opts.name,
    lastMessageTimestamp: msToMicros(opts.lastMessageMs),
    isGroupChat: opts.isGroup ?? false,
    participants: [
      { ID: { participantID: "p-me", number: "+15550000000" }, isMe: true, fullName: "Me" },
      { ID: { participantID: `p-${opts.id}`, number: opts.number ?? "" }, fullName: opts.name, isMe: false },
    ],
    latestMessage: { displayContent: `latest in ${opts.name}` },
  });

const message = (opts: {
  id: string;
  conversationId: string;
  timestampMs: number;
  text: string;
  fromMe?: boolean;
  senderName?: string;
  senderNumber?: string;
  tmpId?: string;
  media?: {
    id: string;
    key: Uint8Array;
    mimeType: string;
    name: string;
    size: number;
    /** The id and key are the preview's; the original is not uploaded. */
    thumbnail?: boolean;
    partId?: string;
  };
}): Message =>
  create(MessageSchema, {
    messageID: opts.id,
    conversationID: opts.conversationId,
    timestamp: msToMicros(opts.timestampMs),
    tmpID: opts.tmpId ?? "",
    messageInfo: [
      { data: { case: "messageContent", value: { content: opts.text } } },
      ...(opts.media === undefined
        ? []
        : [
            {
              actionMessageID: opts.media.partId ?? `part-${opts.id}`,
              data: {
                case: "mediaContent" as const,
                value: {
                  ...(opts.media.thumbnail === true
                    ? { thumbnailMediaID: opts.media.id, thumbnailDecryptionKey: opts.media.key }
                    : { mediaID: opts.media.id, decryptionKey: opts.media.key }),
                  mimeType: opts.media.mimeType,
                  mediaName: opts.media.name,
                  size: BigInt(opts.media.size),
                },
              },
            },
          ]),
    ],
    messageStatus: {
      status: opts.fromMe ? MessageStatusType.OUTGOING_DELIVERED : MessageStatusType.INCOMING_COMPLETE,
    },
    senderParticipant: {
      isMe: opts.fromMe ?? false,
      fullName: opts.senderName ?? "",
      ID: { number: opts.senderNumber ?? "" },
    },
  });

/** Scripted phone state behind a FakeClient. Mutate between syncs to simulate new traffic. */
export type FakePhone = {
  conversations: Conversation[];
  /** Per conversation, any order; served newest first. */
  messages: Map<string, Message[]>;
  contacts: Contact[];
  /** Emitted right after connect, as if they arrived on the long poll. */
  connectEvents: GMEvent[];
  connectError: GMConnectError | null;
  sendStatus: SendMessageResponse_Status;
  sendError: GMRpcError | null;
  /** Decrypted attachment bytes by media id; a missing id answers HTTP 404. */
  media: Map<string, { key: Uint8Array; data: Uint8Array }>;
  /** Called when the original of a part is requested (tests swap in the upgraded message here). */
  onFullSizeRequest: (messageId: string, partId: string) => void;
  /** Called before every RPC (tests advance a fake clock here). */
  beforeRpc: () => void;
  readonly calls: {
    connect: number;
    close: number;
    listConversations: { count: number; cursor: Cursor | undefined }[];
    fetchMessages: { conversationId: string; count: number; cursor: Cursor | undefined }[];
    sendMessage: SendMessageRequest[];
    getOrCreate: number;
    downloadMedia: string[];
    fullSize: { messageId: string; partId: string }[];
  };
};

const fakePhone = (init: Partial<Omit<FakePhone, "calls">> = {}): FakePhone => ({
  conversations: [],
  messages: new Map(),
  contacts: [],
  connectEvents: [],
  connectError: null,
  sendStatus: SendMessageResponse_Status.SUCCESS,
  sendError: null,
  media: new Map(),
  onFullSizeRequest: () => {},
  beforeRpc: () => {},
  ...init,
  calls: { connect: 0, close: 0, listConversations: [], fetchMessages: [], sendMessage: [], getOrCreate: 0, downloadMedia: [], fullSize: [] },
});

const newestFirst = (messages: readonly Message[]) =>
  [...messages].sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp > b.timestamp ? -1 : 1));

/** A GMClient factory backed by `phone`. Pass as `withPhone`'s `createClient`. */
const fakeClient =
  (phone: FakePhone) =>
  (options: GMClientOptions): GMClient => {
    const emit = options.onEvent ?? (() => {});
    return {
      authData: options.authData,
      connect: async () => {
        phone.calls.connect += 1;
        if (phone.connectError !== null) return Result.err(phone.connectError);
        for (const event of phone.connectEvents) emit(event);
        return Result.ok(undefined);
      },
      close: async () => {
        phone.calls.close += 1;
      },
      waitForQuiet: async () => {},
      listConversations: async (req) => {
        phone.beforeRpc();
        phone.calls.listConversations.push({ count: req.count, cursor: req.cursor });
        const sorted = [...phone.conversations].sort((a, b) =>
          a.lastMessageTimestamp === b.lastMessageTimestamp ? 0 : a.lastMessageTimestamp > b.lastMessageTimestamp ? -1 : 1,
        );
        const start = req.cursor === undefined ? 0 : sorted.findIndex((c) => c.conversationID === req.cursor?.lastItemID) + 1;
        const page = sorted.slice(start, start + req.count);
        const last = page.at(-1);
        const more = start + page.length < sorted.length;
        return Result.ok(
          create(ListConversationsResponseSchema, {
            conversations: page,
            cursor:
              more && last !== undefined
                ? create(CursorSchema, { lastItemID: last.conversationID, lastItemTimestamp: last.lastMessageTimestamp })
                : undefined,
          }),
        );
      },
      fetchMessages: async (req) => {
        phone.beforeRpc();
        phone.calls.fetchMessages.push({ conversationId: req.conversationId, count: req.count, cursor: req.cursor });
        const sorted = newestFirst(phone.messages.get(req.conversationId) ?? []);
        const start = req.cursor === undefined ? 0 : sorted.findIndex((m) => m.messageID === req.cursor?.lastItemID) + 1;
        const page = sorted.slice(start, start + req.count);
        const oldest = page.at(-1);
        const more = start + page.length < sorted.length;
        return Result.ok(
          create(ListMessagesResponseSchema, {
            // Google returns pages oldest first.
            messages: [...page].reverse(),
            totalMessages: BigInt(sorted.length),
            cursor:
              more && oldest !== undefined
                ? create(CursorSchema, { lastItemID: oldest.messageID, lastItemTimestamp: oldest.timestamp })
                : undefined,
          }),
        );
      },
      getConversation: async (conversationId) => {
        phone.beforeRpc();
        const found = phone.conversations.find((c) => c.conversationID === conversationId);
        return found === undefined
          ? Result.err(phone.sendError ?? missing(conversationId))
          : Result.ok(found);
      },
      getOrCreateConversation: async (req) => {
        phone.beforeRpc();
        phone.calls.getOrCreate += 1;
        const number = req.numbers[0]?.number ?? "";
        const existing = phone.conversations.find((c) =>
          c.participants.some((p) => !p.isMe && p.ID?.number === number),
        );
        const created =
          existing ?? conversation({ id: `conv-${number}`, name: number, lastMessageMs: 0, number });
        if (existing === undefined) phone.conversations.push(created);
        return Result.ok(
          create(GetOrCreateConversationResponseSchema, {
            conversation: created,
            status: GetOrCreateConversationResponse_Status.SUCCESS,
          }),
        );
      },
      sendMessage: async (req) => {
        phone.beforeRpc();
        phone.calls.sendMessage.push(req);
        if (phone.sendError !== null) return Result.err(phone.sendError);
        return Result.ok(create(SendMessageResponseSchema, { status: phone.sendStatus }));
      },
      sendReaction: async () => Result.ok(create(SendReactionResponseSchema, {})),
      markRead: async () => Result.ok(undefined),
      listContacts: async () => {
        phone.beforeRpc();
        return Result.ok(create(ListContactsResponseSchema, { contacts: phone.contacts }));
      },
      listTopContacts: async () => Result.ok(create(ListTopContactsResponseSchema, {})),
      requestFullSizeImage: async (messageId, partId) => {
        phone.beforeRpc();
        phone.calls.fullSize.push({ messageId, partId });
        phone.onFullSizeRequest(messageId, partId);
        return Result.ok(undefined);
      },
      downloadMedia: async (req) => {
        phone.calls.downloadMedia.push(req.mediaId);
        const found = phone.media.get(req.mediaId);
        if (found === undefined || Buffer.compare(found.key, req.key) !== 0) {
          return Result.err(
            new GMHttpError({ status: found === undefined ? 404 : 403, action: "downloading media", message: "media refused" }),
          );
        }
        return Result.ok(new Blob([new Uint8Array(found.data)]).stream());
      },
      unpair: async () => Result.ok(undefined),
    };
  };

/** A request error for an unknown conversation id. */
const missing = (conversationId: string): GMRpcError =>
  new GMRequestError({
    status: 404,
    action: "GET_CONVERSATION",
    errorType: "5",
    googleMessage: "not found",
    message: `GET_CONVERSATION failed for ${conversationId}: not found`,
  });

/** Mutable clock for deadline tests. */
const clock = (start = Date.UTC(2026, 10, 6, 12, 0, 0)) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

export const RcsTesting = {
  setup,
  pair,
  conversation,
  message,
  fakePhone,
  fakeClient,
  clock,
  createUser: VaultTesting.createUser,
} as const;

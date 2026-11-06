import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

import {
  DeviceSchema,
  GaiaPairingErrorCode,
  GaiaPairingRequestContainerSchema,
  GaiaPairingResponseContainerSchema,
  URLDataSchema,
  type Device,
} from "@/gen/gmproto/authentication_pb";
import {
  GetConversationRequestSchema,
  GetConversationResponseSchema,
  GetOrCreateConversationRequestSchema,
  GetOrCreateConversationResponse_Status,
  GetOrCreateConversationResponseSchema,
  ListContactsResponseSchema,
  ListConversationsRequestSchema,
  ListConversationsResponseSchema,
  ListMessagesRequestSchema,
  ListMessagesResponseSchema,
  ListTopContactsResponseSchema,
  SendMessageRequestSchema,
  SendMessageResponse_Status,
  SendMessageResponseSchema,
  SendReactionResponseSchema,
} from "@/gen/gmproto/client_pb";
import {
  ConversationSchema,
  IdentifierType,
  MessageSchema,
  MessageStatusType,
  type Conversation,
  type Message,
} from "@/gen/gmproto/conversations_pb";
import { EncryptedData2ContainerSchema, RPCPairDataSchema, UpdateEventsSchema } from "@/gen/gmproto/events_pb";

export type UpdateEventInit = MessageInitShape<typeof UpdateEventsSchema>["event"];
import {
  ActionType,
  BugleRoute,
  IncomingRPCMessageSchema,
  MessageType,
  RPCMessageDataSchema,
  type IncomingRPCMessage,
  type OutgoingRPCData,
} from "@/gen/gmproto/rpc_pb";
import {
  PublicKeyType,
  Ukey2ClientFinishedSchema,
  Ukey2ClientInitSchema,
  Ukey2HandshakeCipher,
  Ukey2Message_Type,
  Ukey2MessageSchema,
  Ukey2ServerInitSchema,
} from "@/gen/gmproto/ukey_pb";

import { AuthData } from "../auth-data";
import { QR_CODE_URL_BASE } from "../constants";
import { AesCtrHelper } from "../crypto/aes-ctr";
import { pairingEmojisV1 } from "../crypto/emoji";
import { Jwk } from "../crypto/jwk";
import { P256KeyPair } from "../crypto/p256";
import { PairingSession } from "../crypto/ukey2";

// A fake phone for end-to-end tests: decrypts requests with the shared keys,
// answers them on the long poll, and plays the UKEY2 server side of Gaia
// pairing using the crypto module.

/** How the phone answers one request. */
export type PhoneReply =
  /** Encrypted response payload (RPCMessageData field 8). */
  | { readonly kind: "response"; readonly bytes: Uint8Array }
  /** Header only: no field 5, 8 or 11. */
  | { readonly kind: "payloadless" }
  /** Only the field-11 account container (a phone switched to Google-account pairing). */
  | { readonly kind: "accountField"; readonly account: string }
  /** Field 5 only (the frames Gaia sessions see before real responses). */
  | { readonly kind: "intermediate" }
  /** Unencrypted data (Gaia pairing answers). */
  | { readonly kind: "plain"; readonly bytes: Uint8Array };

export type PhoneRequest = {
  readonly action: ActionType;
  readonly requestId: string;
  readonly sessionId: string;
  /** Decrypted (or unencrypted) request protobuf; empty when the request had none. */
  readonly payload: Uint8Array;
  readonly messageType: MessageType;
  readonly ttlMicros: bigint;
  readonly destRegIds: readonly string[];
};

export type GaiaBehavior = "accept" | "wrongEmoji" | "cancel" | "notMe" | "silent";

type GaiaServerState = {
  readonly key: P256KeyPair;
  readonly clientInit: Uint8Array;
  readonly serverInit: Uint8Array;
  readonly commitment: Uint8Array;
};

export type PhoneOverride = (req: PhoneRequest) => readonly PhoneReply[] | "default";

export const encodeReply = <Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): PhoneReply => ({
  kind: "response",
  bytes: toBinary(schema, message),
});

const hkdf32 = (key: Uint8Array, salt: string, info: Uint8Array): Uint8Array =>
  new Uint8Array(hkdfSync("sha256", key, Buffer.from(salt, "utf8"), info, 32));

const strip33 = (value: Uint8Array): Uint8Array => (value.length === 33 ? value.subarray(1) : value);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const prefixed = (value: Uint8Array): Uint8Array => {
  const out = new Uint8Array(33);
  out.set(value, 1);
  return out;
};

const nowMicros = (): bigint => BigInt(Date.now()) * 1000n;

export type FakePhone = {
  /** Shared request crypto; set at creation for paired sessions, after pairing otherwise. */
  crypto: AesCtrHelper | null;
  readonly mobile: Device;
  readonly browser: Device;
  /** Tachyon token handed out when the browser pairs. */
  readonly pairedToken: Uint8Array;
  online: boolean;
  gaiaBehavior: GaiaBehavior;
  /** Registration id the phone uses for Gaia pairing. */
  readonly regId: string;
  readonly conversations: Conversation[];
  readonly messages: Map<string, Message[]>;
  readonly received: PhoneRequest[];
  activeSessionId: string | null;
  /** Emoji the phone computed for the latest Gaia attempt. */
  expectedEmoji: string | null;
  cancels: number;
  /** Replace the default answer for one action. Return "default" to fall through. */
  override(action: ActionType, fn: PhoneOverride): void;
  /** The default answers for a request (for overrides that add frames around them). */
  handleDefault(req: PhoneRequest): readonly PhoneReply[];
  /** AuthData for a session already paired with this phone (QR, or Gaia when `cookies` is set). */
  pairedAuthData(opts?: { readonly cookies?: Record<string, string>; readonly tokenExpiresInMs?: number }): AuthData;
  /** Handles one SendMessage RPC; returns the frames to put on the long poll. */
  handle(data: OutgoingRPCData, meta: { readonly messageType: MessageType; readonly ttlMicros: bigint; readonly destRegIds: readonly string[] }): IncomingRPCMessage[];
  /** A GET_UPDATES frame for the active session. */
  updateFrame(event: UpdateEventInit): IncomingRPCMessage;
  /** The QR PairEvent Paired frame after scanning `qrUrl`; the phone adopts the URL's keys. */
  scanQr(qrUrl: string): IncomingRPCMessage;
  /** A data frame answering `requestId`. */
  frame(requestId: string, action: ActionType, reply: PhoneReply): IncomingRPCMessage;
};

/** A one-to-one conversation with an emoji in its name (exercises UTF-8 through the stream). */
export const sampleConversation = (id: string, number: string): Conversation =>
  create(ConversationSchema, {
    conversationID: id,
    name: `Friend ${id} 😀`,
    lastMessageTimestamp: 1_762_435_200_000_000n,
    participants: [
      { ID: { type: IdentifierType.PHONE, number: "+15550000001", participantID: "p-me" }, isMe: true, simPayload: { two: 2, SIMNumber: 1 } },
      { ID: { type: IdentifierType.PHONE, number, participantID: `p-${id}` }, fullName: `Friend ${id}` },
    ],
    latestMessage: { displayContent: "hi 👋" },
  });

export const sampleMessage = (conversationId: string, id: string, text: string, timestampMicros: bigint): Message =>
  create(MessageSchema, {
    messageID: id,
    conversationID: conversationId,
    timestamp: timestampMicros,
    participantID: `p-${conversationId}`,
    messageInfo: [{ data: { case: "messageContent", value: { content: text } } }],
    messageStatus: { status: MessageStatusType.INCOMING_COMPLETE },
    senderParticipant: { ID: { number: "+15550000002", participantID: `p-${conversationId}` }, fullName: "Friend" },
  });

export const FakePhone = {
  create(opts: { readonly paired?: boolean } = {}): FakePhone {
    const overrides = new Map<ActionType, PhoneOverride>();
    const gaia = new Map<string, GaiaServerState>();
    const mobile = create(DeviceSchema, { userID: 1n, sourceID: "fake-phone-source", network: "Bugle" });
    const browser = create(DeviceSchema, { userID: 2n, sourceID: "FAKE-BROWSER-SOURCE", network: "Bugle" });

    const frame = (requestId: string, action: ActionType, reply: PhoneReply): IncomingRPCMessage => {
      const empty = new Uint8Array(0);
      const encrypt = (bytes: Uint8Array): Uint8Array => {
        if (phone.crypto === null) throw new Error("fake phone has no request crypto yet; pair it first");
        return AesCtrHelper.encrypt(phone.crypto, bytes);
      };
      const data = create(RPCMessageDataSchema, {
        sessionID: requestId,
        timestamp: nowMicros(),
        action,
        unencryptedData: reply.kind === "plain" ? reply.bytes : reply.kind === "intermediate" ? Uint8Array.of(0x08, 0x01) : empty,
        encryptedData: reply.kind === "response" ? encrypt(reply.bytes) : empty,
        encryptedData2:
          reply.kind === "accountField"
            ? encrypt(toBinary(EncryptedData2ContainerSchema, create(EncryptedData2ContainerSchema, { accountChange: { account: reply.account } })))
            : empty,
      });
      return create(IncomingRPCMessageSchema, {
        responseID: randomUUID(),
        bugleRoute: BugleRoute.DataEvent,
        messageType: MessageType.BUGLE_MESSAGE,
        mobile,
        browser,
        messageData: toBinary(RPCMessageDataSchema, data),
        // Non-ASCII and JSON-special characters, so stream chunks split inside them.
        signatureID: 'sig-ß-😀-"]["',
      });
    };

    const decryptRequest = (data: OutgoingRPCData): Uint8Array => {
      if (data.unencryptedProtoData.length > 0) return data.unencryptedProtoData;
      if (data.encryptedProtoData.length === 0) return new Uint8Array(0);
      if (phone.crypto === null) throw new Error("fake phone got an encrypted request before pairing");
      return AesCtrHelper.decrypt(phone.crypto, data.encryptedProtoData).unwrap("fake phone could not decrypt a request");
    };

    const gaiaInit = (req: PhoneRequest): PhoneReply[] => {
      const container = fromBinary(GaiaPairingRequestContainerSchema, req.payload);
      const clientInitMsg = fromBinary(Ukey2MessageSchema, container.data);
      const clientInit = fromBinary(Ukey2ClientInitSchema, clientInitMsg.messageData);
      const key = P256KeyPair.generate();
      const serverInitPayload = toBinary(
        Ukey2ServerInitSchema,
        create(Ukey2ServerInitSchema, {
          version: 1,
          random: new Uint8Array(randomBytes(32)),
          handshakeCipher: Ukey2HandshakeCipher.P256_SHA512,
          publicKey: { type: PublicKeyType.EC_P256, publicKey: { case: "ecP256PublicKey", value: { x: prefixed(key.x), y: prefixed(key.y) } } },
        }),
      );
      const serverInit = toBinary(
        Ukey2MessageSchema,
        create(Ukey2MessageSchema, { messageType: Ukey2Message_Type.SERVER_INIT, messageData: serverInitPayload }),
      );
      gaia.set(container.pairingAttemptID, {
        key,
        clientInit: container.data,
        serverInit,
        commitment: clientInit.cipherCommitments[0]?.commitment ?? new Uint8Array(0),
      });
      const response = create(GaiaPairingResponseContainerSchema, {
        unknownInt3: 1,
        sessionUUID: container.pairingAttemptID,
        data: serverInit,
        confirmedVerificationCodeVersion: 1,
        confirmedKeyDerivationVersion: 1,
      });
      return [{ kind: "plain", bytes: toBinary(GaiaPairingResponseContainerSchema, response) }];
    };

    const gaiaFinish = (req: PhoneRequest): PhoneReply[] => {
      const container = fromBinary(GaiaPairingRequestContainerSchema, req.payload);
      const state = gaia.get(container.pairingAttemptID);
      if (state === undefined) throw new Error("fake phone got CLIENT_FINISHED for an unknown attempt");
      const commitment = createHash("sha512").update(container.data).digest();
      if (!equalBytes(new Uint8Array(commitment), state.commitment)) throw new Error("CLIENT_FINISH does not match the CLIENT_INIT commitment");
      const finished = fromBinary(Ukey2ClientFinishedSchema, fromBinary(Ukey2MessageSchema, container.data).messageData);
      const pub = finished.publicKey?.publicKey;
      if (pub?.case !== "ecP256PublicKey") throw new Error("CLIENT_FINISH has no EC public key");
      const dh = P256KeyPair.sharedSecret(state.key, strip33(pub.value.x), strip33(pub.value.y)).unwrap();
      const shared = new Uint8Array(createHash("sha256").update(dh).digest());
      const authInfo = Buffer.concat([state.clientInit, state.serverInit]);
      const auth = hkdf32(shared, "UKEY2 v1 auth", authInfo);
      const nextKey = hkdf32(shared, "UKEY2 v1 next", authInfo);
      const authNumber = new DataView(auth.buffer, auth.byteOffset, auth.byteLength).getUint32(0, false);
      phone.expectedEmoji = pairingEmojisV1[authNumber % pairingEmojisV1.length] ?? null;
      const answer = (errorType: number, code: GaiaPairingErrorCode): PhoneReply[] => [
        {
          kind: "plain",
          bytes: toBinary(
            GaiaPairingResponseContainerSchema,
            create(GaiaPairingResponseContainerSchema, { finishErrorType: errorType, finishErrorCode: code, sessionUUID: container.pairingAttemptID }),
          ),
        },
      ];
      switch (phone.gaiaBehavior) {
        case "accept":
          phone.crypto = PairingSession.deriveRequestCrypto(nextKey, 1).unwrap();
          return answer(0, GaiaPairingErrorCode.NONE);
        case "wrongEmoji":
          return answer(1, GaiaPairingErrorCode.WRONG_VERIFICATION_CODE_SELECTED);
        case "cancel":
          return answer(1, GaiaPairingErrorCode.USER_CANCELED_VERIFICATION);
        case "notMe":
          return answer(1, GaiaPairingErrorCode.USER_DENIED_VERIFICATION_NOT_ME);
        case "silent":
          return [];
      }
    };

    const defaultReplies = (req: PhoneRequest): readonly PhoneReply[] => {
      switch (req.action) {
        case ActionType.GET_UPDATES:
          phone.activeSessionId = req.requestId;
          return [];
        case ActionType.LIST_CONVERSATIONS: {
          const r = fromBinary(ListConversationsRequestSchema, req.payload);
          return [encodeReply(ListConversationsResponseSchema, create(ListConversationsResponseSchema, { conversations: phone.conversations.slice(0, Number(r.count)) }))];
        }
        case ActionType.LIST_MESSAGES: {
          const r = fromBinary(ListMessagesRequestSchema, req.payload);
          const messages = phone.messages.get(r.conversationID) ?? [];
          return [encodeReply(ListMessagesResponseSchema, create(ListMessagesResponseSchema, { messages: messages.slice(0, Number(r.count)), totalMessages: BigInt(messages.length) }))];
        }
        case ActionType.GET_CONVERSATION: {
          const r = fromBinary(GetConversationRequestSchema, req.payload);
          const conversation = phone.conversations.find((c) => c.conversationID === r.conversationID);
          return [encodeReply(GetConversationResponseSchema, create(GetConversationResponseSchema, { conversation }))];
        }
        case ActionType.GET_OR_CREATE_CONVERSATION: {
          const r = fromBinary(GetOrCreateConversationRequestSchema, req.payload);
          const number = r.numbers[0]?.number ?? "";
          let conversation = phone.conversations.find((c) => c.participants.some((p) => !p.isMe && p.ID?.number === number));
          if (conversation === undefined) {
            conversation = sampleConversation(`c${phone.conversations.length + 1}`, number);
            phone.conversations.push(conversation);
          }
          return [
            encodeReply(
              GetOrCreateConversationResponseSchema,
              create(GetOrCreateConversationResponseSchema, { conversation, status: GetOrCreateConversationResponse_Status.SUCCESS }),
            ),
          ];
        }
        case ActionType.SEND_MESSAGE: {
          const r = fromBinary(SendMessageRequestSchema, req.payload);
          const text = r.messagePayload?.messageInfo[0]?.data.case === "messageContent" ? r.messagePayload.messageInfo[0].data.value.content : "";
          const sent = create(MessageSchema, {
            messageID: `m-sent-${phone.received.length}`,
            conversationID: r.conversationID,
            timestamp: nowMicros(),
            tmpID: r.tmpID,
            messageInfo: [{ data: { case: "messageContent", value: { content: text } } }],
            messageStatus: { status: MessageStatusType.OUTGOING_COMPLETE },
            senderParticipant: { isMe: true },
          });
          const list = phone.messages.get(r.conversationID) ?? [];
          list.unshift(sent);
          phone.messages.set(r.conversationID, list);
          pendingUpdates.push({ case: "messageEvent", value: { data: [sent] } });
          return [encodeReply(SendMessageResponseSchema, create(SendMessageResponseSchema, { status: SendMessageResponse_Status.SUCCESS }))];
        }
        case ActionType.SEND_REACTION:
          return [encodeReply(SendReactionResponseSchema, create(SendReactionResponseSchema, { success: true }))];
        case ActionType.LIST_CONTACTS:
          return [encodeReply(ListContactsResponseSchema, create(ListContactsResponseSchema))];
        case ActionType.LIST_TOP_CONTACTS:
          return [encodeReply(ListTopContactsResponseSchema, create(ListTopContactsResponseSchema))];
        case ActionType.CREATE_GAIA_PAIRING_CLIENT_INIT:
          return gaiaInit(req);
        case ActionType.CREATE_GAIA_PAIRING_CLIENT_FINISHED:
          return gaiaFinish(req);
        case ActionType.CANCEL_GAIA_PAIRING:
          phone.cancels++;
          return [];
        case ActionType.ACK_BROWSER_PRESENCE:
        case ActionType.UNPAIR_GAIA_PAIRING:
          return [];
        default:
          return [{ kind: "payloadless" }];
      }
    };

    const pendingUpdates: UpdateEventInit[] = [];

    const phone: FakePhone = {
      crypto: opts.paired === false ? null : AesCtrHelper.generate(),
      mobile,
      browser,
      pairedToken: new Uint8Array(randomBytes(24)),
      online: true,
      gaiaBehavior: "accept",
      regId: randomUUID(),
      conversations: [],
      messages: new Map(),
      received: [],
      activeSessionId: null,
      expectedEmoji: null,
      cancels: 0,

      override(action, fn) {
        overrides.set(action, fn);
      },

      handleDefault: (req) => defaultReplies(req),

      pairedAuthData(o = {}) {
        if (phone.crypto === null) throw new Error("fake phone is not paired");
        const auth = AuthData.createForPairing();
        auth.requestCrypto = phone.crypto;
        auth.refreshKey = Jwk.generate();
        auth.browser = browser;
        auth.mobile = mobile;
        auth.tachyonAuthToken = phone.pairedToken;
        auth.tachyonTtlMicros = 86_400_000_000n;
        auth.tachyonExpiry = new Date(Date.now() + (o.tokenExpiresInMs ?? 6 * 60 * 60 * 1000));
        if (o.cookies !== undefined) {
          auth.cookies = { ...o.cookies };
          auth.destRegId = phone.regId;
          auth.pairingId = randomUUID();
        }
        return auth;
      },

      handle(data, meta) {
        const req: PhoneRequest = {
          action: data.action,
          requestId: data.requestID,
          sessionId: data.sessionID,
          payload: decryptRequest(data),
          messageType: meta.messageType,
          ttlMicros: meta.ttlMicros,
          destRegIds: meta.destRegIds,
        };
        phone.received.push(req);
        if (!phone.online) return [];
        const custom = overrides.get(req.action)?.(req);
        const replies = custom === undefined || custom === "default" ? defaultReplies(req) : custom;
        const frames = replies.map((reply) => frame(req.requestId, req.action, reply));
        for (const event of pendingUpdates.splice(0)) frames.push(phone.updateFrame(event));
        return frames;
      },

      updateFrame(event) {
        return frame(phone.activeSessionId ?? "no-active-session", ActionType.GET_UPDATES, encodeReply(UpdateEventsSchema, create(UpdateEventsSchema, { event })));
      },

      scanQr(qrUrl) {
        if (!qrUrl.startsWith(QR_CODE_URL_BASE)) throw new Error("not a Google Messages QR URL");
        const urlData = fromBinary(URLDataSchema, new Uint8Array(Buffer.from(qrUrl.slice(QR_CODE_URL_BASE.length), "base64")));
        phone.crypto = AesCtrHelper.fromKeys(urlData.AESKey, urlData.HMACKey).unwrap();
        const pair = create(RPCPairDataSchema, {
          event: {
            case: "paired",
            value: { mobile, browser, tokenData: { tachyonAuthToken: phone.pairedToken, TTL: 86_400_000_000n } },
          },
        });
        return create(IncomingRPCMessageSchema, {
          responseID: randomUUID(),
          bugleRoute: BugleRoute.PairEvent,
          messageType: MessageType.BUGLE_MESSAGE,
          messageData: toBinary(RPCPairDataSchema, pair),
        });
      },

      frame,
    };
    return phone;
  },
} as const;

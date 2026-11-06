import { createHash } from "node:crypto";
import { create, fromBinary, isMessage, type DescMessage, type Message } from "@bufbuild/protobuf";
import { Result } from "better-result";

import {
  GetConversationResponseSchema,
  GetConversationTypeResponseSchema,
  GetFullSizeImageResponseSchema,
  GetOrCreateConversationResponseSchema,
  GetThumbnailResponseSchema,
  DeleteMessageResponseSchema,
  IsBugleDefaultResponseSchema,
  ListContactsResponseSchema,
  ListConversationsResponseSchema,
  ListMessagesResponseSchema,
  ListTopContactsResponseSchema,
  NotifyDittoActivityResponseSchema,
  SendMessageResponseSchema,
  SendReactionResponseSchema,
  UpdateConversationResponseSchema,
} from "@/gen/gmproto/client_pb";
import type { Conversation, Message as GMProtoMessage } from "@/gen/gmproto/conversations_pb";
import {
  EncryptedData2ContainerSchema,
  RPCPairDataSchema,
  UpdateEventsSchema,
  type AccountChangeOrSomethingEvent,
  type RPCPairData,
  type TypingData,
  type UserAlertEvent,
} from "@/gen/gmproto/events_pb";
import { RPCGaiaDataSchema, type RPCGaiaData } from "@/gen/gmproto/authentication_pb";
import {
  ActionType,
  BugleRoute,
  MessageType,
  RPCMessageDataSchema,
  type IncomingRPCMessage,
  type RPCMessageData,
} from "@/gen/gmproto/rpc_pb";

import { AesCtrHelper } from "./crypto/aes-ctr";
import { GMDecodeError, type GMHttpError } from "./errors";
import type { GMLogger } from "./logger";

// libgm event_handler.go + response_acceptance.go (ResponseShape): decoding
// and decrypting IncomingRPCMessage frames, and turning GET_UPDATES events
// into GMEvents.

export type GMEvent =
  | { type: "message"; message: GMProtoMessage; isOld: boolean }
  | { type: "conversation"; conversation: Conversation }
  | { type: "typing"; data: TypingData }
  | { type: "userAlert"; alert: UserAlertEvent }
  /** Token refreshed or cookies rotated: persist AuthData. */
  | { type: "authDataChanged" }
  /** The session is dead: needs re-pair. */
  | { type: "gaiaLoggedOut" }
  | { type: "accountChange"; account: string; isFake: boolean }
  /** 401/403 on the long poll: needs re-pair. */
  | { type: "listenFatal"; error: GMHttpError }
  | { type: "listenTemporary"; message: string };

/** Envelope summary of a data-route frame, without any content (libgm ResponseShape). */
export type ResponseShape = {
  readonly route: BugleRoute;
  readonly action: ActionType;
  readonly messageType: MessageType;
  /** RPCMessageData field 5. */
  readonly hasUnencrypted: boolean;
  readonly unencryptedLen: number;
  /** Field 8: the encrypted response payload. */
  readonly hasPayload: boolean;
  readonly payloadLen: number;
  /** Field 11: the account-container side channel. */
  readonly hasAccountField: boolean;
  readonly accountFieldLen: number;
  readonly decryptedLen: number;
  readonly decodedType: string;
  readonly gdittoSource: boolean;
  /** Field 11 named a Google account (the phone switched to Google-account pairing). */
  readonly accountSwitch: boolean;
};

export type DataRpc = {
  readonly route: "data";
  readonly raw: IncomingRPCMessage;
  readonly data: RPCMessageData;
  readonly decryptedData: Uint8Array | null;
  /** The action's response message (libgm responseType), empty when there was no payload. */
  readonly decrypted: Message | null;
  readonly shape: ResponseShape;
};

export type IncomingRpc =
  | { readonly route: "pair"; readonly raw: IncomingRPCMessage; readonly pair: RPCPairData }
  | { readonly route: "gaia"; readonly raw: IncomingRPCMessage; readonly gaia: RPCGaiaData }
  | DataRpc;

export type DecodedIncoming = {
  readonly rpc: IncomingRpc;
  /** Set when an EncryptedData2 container named a Google account (libgm's fake AccountChange). */
  readonly accountChange: AccountChangeOrSomethingEvent | null;
};

/** libgm responseType. */
const RESPONSE_TYPES: ReadonlyMap<ActionType, DescMessage> = new Map<ActionType, DescMessage>([
  [ActionType.IS_BUGLE_DEFAULT, IsBugleDefaultResponseSchema],
  [ActionType.GET_UPDATES, UpdateEventsSchema],
  [ActionType.LIST_CONVERSATIONS, ListConversationsResponseSchema],
  [ActionType.NOTIFY_DITTO_ACTIVITY, NotifyDittoActivityResponseSchema],
  [ActionType.GET_CONVERSATION_TYPE, GetConversationTypeResponseSchema],
  [ActionType.GET_CONVERSATION, GetConversationResponseSchema],
  [ActionType.LIST_MESSAGES, ListMessagesResponseSchema],
  [ActionType.SEND_MESSAGE, SendMessageResponseSchema],
  [ActionType.SEND_REACTION, SendReactionResponseSchema],
  [ActionType.DELETE_MESSAGE, DeleteMessageResponseSchema],
  [ActionType.GET_PARTICIPANTS_THUMBNAIL, GetThumbnailResponseSchema],
  [ActionType.GET_CONTACTS_THUMBNAIL, GetThumbnailResponseSchema],
  [ActionType.LIST_CONTACTS, ListContactsResponseSchema],
  [ActionType.LIST_TOP_CONTACTS, ListTopContactsResponseSchema],
  [ActionType.GET_OR_CREATE_CONVERSATION, GetOrCreateConversationResponseSchema],
  [ActionType.UPDATE_CONVERSATION, UpdateConversationResponseSchema],
  [ActionType.GET_FULL_SIZE_IMAGE, GetFullSizeImageResponseSchema],
]);

export const actionName = (action: ActionType): string => ActionType[action] ?? String(action);

const decodeError = (responseId: string, what: string, cause?: unknown): GMDecodeError =>
  new GMDecodeError({
    action: "receiving",
    message: `Could not decode incoming Google Messages frame ${responseId} (${what}); it was acknowledged and skipped. If this repeats for every frame, the session keys may be out of sync and the phone must be re-paired.`,
    cause,
  });

const tryBinary = <T>(fn: () => T): Result<T, unknown> => {
  try {
    return Result.ok(fn());
  } catch (cause) {
    return Result.err(cause);
  }
};

/** libgm decryptInternalMessage. */
const decode = (raw: IncomingRPCMessage, crypto: AesCtrHelper): Result<DecodedIncoming, GMDecodeError> => {
  const id = raw.responseID;
  switch (raw.bugleRoute) {
    case BugleRoute.PairEvent: {
      const pair = tryBinary(() => fromBinary(RPCPairDataSchema, raw.messageData));
      if (pair.isErr()) return Result.err(decodeError(id, "pair event is not RPCPairData", pair.error));
      return Result.ok({ rpc: { route: "pair", raw, pair: pair.value }, accountChange: null });
    }
    case BugleRoute.GaiaEvent: {
      const gaia = tryBinary(() => fromBinary(RPCGaiaDataSchema, raw.messageData));
      if (gaia.isErr()) return Result.err(decodeError(id, "gaia event is not RPCGaiaData", gaia.error));
      return Result.ok({ rpc: { route: "gaia", raw, gaia: gaia.value }, accountChange: null });
    }
    case BugleRoute.DataEvent: {
      const parsed = tryBinary(() => fromBinary(RPCMessageDataSchema, raw.messageData));
      if (parsed.isErr()) return Result.err(decodeError(id, "data event is not RPCMessageData", parsed.error));
      const data = parsed.value;
      const schema = RESPONSE_TYPES.get(data.action);
      let decrypted: Message | null = schema === undefined ? null : create(schema);
      let decryptedData: Uint8Array | null = null;
      let accountChange: AccountChangeOrSomethingEvent | null = null;
      // Go: proto3 bytes decode to nil when empty, so "!= nil" is "non-empty".
      if (data.encryptedData.length > 0) {
        const plain = AesCtrHelper.decrypt(crypto, data.encryptedData);
        if (plain.isErr()) return Result.err(decodeError(id, `payload did not decrypt: ${plain.error.message}`, plain.error));
        decryptedData = plain.value;
        if (schema !== undefined) {
          const message = tryBinary(() => fromBinary(schema, plain.value));
          if (message.isErr()) {
            return Result.err(decodeError(id, `decrypted payload is not ${schema.typeName}`, message.error));
          }
          decrypted = message.value;
        }
      } else if (data.encryptedData2.length > 0) {
        const plain = AesCtrHelper.decrypt(crypto, data.encryptedData2);
        if (plain.isErr()) {
          return Result.err(decodeError(id, `field 2 payload did not decrypt: ${plain.error.message}`, plain.error));
        }
        decryptedData = plain.value;
        const container = tryBinary(() => fromBinary(EncryptedData2ContainerSchema, plain.value));
        if (container.isErr()) {
          return Result.err(decodeError(id, "decrypted field 2 payload is not EncryptedData2Container", container.error));
        }
        const change = container.value.accountChange;
        if (change !== undefined && change.account.includes("@")) accountChange = change;
      }
      const shape: ResponseShape = {
        route: raw.bugleRoute,
        action: data.action,
        messageType: raw.messageType,
        hasUnencrypted: data.unencryptedData.length > 0,
        unencryptedLen: data.unencryptedData.length,
        hasPayload: data.encryptedData.length > 0,
        payloadLen: data.encryptedData.length,
        hasAccountField: data.encryptedData2.length > 0,
        accountFieldLen: data.encryptedData2.length,
        decryptedLen: decryptedData?.length ?? 0,
        decodedType: decrypted?.$typeName ?? "",
        gdittoSource: raw.gdittoSource !== undefined,
        accountSwitch: accountChange !== null,
      };
      return Result.ok({ rpc: { route: "data", raw, data, decryptedData, decrypted, shape }, accountChange });
    }
    default:
      return Result.err(decodeError(id, `unknown bugle route ${raw.bugleRoute}`));
  }
};

/** Loggable fields of a shape (no content). */
const shapeFields = (shape: ResponseShape): Record<string, string | number | boolean> => ({
  action: actionName(shape.action),
  messageType: MessageType[shape.messageType] ?? shape.messageType,
  f5: shape.unencryptedLen,
  f8: shape.payloadLen,
  f11: shape.accountFieldLen,
  decoded: shape.decodedType,
  gdittoSource: shape.gdittoSource,
  accountSwitch: shape.accountSwitch,
});

// ---- Update dedup (libgm deduplicateHash, ring of 8) ----

export type UpdateDedup = {
  /** True when (id, hash) repeats the latest stored entry for id; otherwise stores it. */
  isDuplicate(id: string, hash: string): boolean;
};

const DEDUP_SIZE = 8;

const createDedup = (): UpdateDedup => {
  const ring: { id: string; hash: string }[] = Array.from({ length: DEDUP_SIZE }, () => ({ id: "", hash: "" }));
  let ptr = 0;
  return {
    isDuplicate(id, hash) {
      for (let i = ptr + DEDUP_SIZE - 1; i >= ptr; i--) {
        const entry = ring[i % DEDUP_SIZE];
        if (entry !== undefined && entry.id === id) {
          if (entry.hash === hash) return true;
          break;
        }
      }
      ring[ptr] = { id, hash };
      ptr = (ptr + 1) % DEDUP_SIZE;
      return false;
    },
  };
};

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export type UpdateEffect = { readonly kind: "event"; readonly event: GMEvent } | { readonly kind: "ackBrowserPresence" };

const LOGGED_OUT_BYTES = Uint8Array.of(0x72, 0x00);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** libgm handleUpdatesEvent for a data-route frame that answered no pending request. */
const routeUpdate = (rpc: DataRpc, isOld: boolean, dedup: UpdateDedup, logger: GMLogger): UpdateEffect[] => {
  const effects: UpdateEffect[] = [];
  if (rpc.data.action !== ActionType.GET_UPDATES) {
    logger.debug("received a response nobody is waiting for", { ...shapeFields(rpc.shape), isOld });
    return effects;
  }
  if (rpc.decryptedData === null && equalBytes(rpc.data.unencryptedData, LOGGED_OUT_BYTES)) {
    effects.push({ kind: "event", event: { type: "gaiaLoggedOut" } });
    return effects;
  }
  if (!isMessage(rpc.decrypted, UpdateEventsSchema)) {
    logger.error("GET_UPDATES frame did not decode to UpdateEvents", { isOld });
    return effects;
  }
  const isDuplicate = (id: string): boolean =>
    rpc.decryptedData !== null && dedup.isDuplicate(id, sha256Hex(rpc.decryptedData));
  const event = rpc.decrypted.event;
  switch (event.case) {
    case "userAlertEvent":
      if (!isOld) effects.push({ kind: "event", event: { type: "userAlert", alert: event.value } });
      break;
    case "settingsEvent":
      logger.debug("received a settings event", { isOld });
      break;
    case "conversationEvent":
      for (const conversation of event.value.data) {
        if (isDuplicate(conversation.conversationID)) return effects;
        if (isOld) continue;
        effects.push({ kind: "event", event: { type: "conversation", conversation } });
      }
      break;
    case "messageEvent":
      for (const message of event.value.data) {
        if (isDuplicate(message.messageID)) return effects;
        effects.push({ kind: "event", event: { type: "message", message, isOld } });
      }
      break;
    case "typingEvent":
      if (!isOld && event.value.data !== undefined) {
        effects.push({ kind: "event", event: { type: "typing", data: event.value.data } });
      }
      break;
    case "browserPresenceCheckEvent":
      effects.push({ kind: "ackBrowserPresence" });
      break;
    case "accountChange":
      effects.push({ kind: "event", event: { type: "accountChange", account: event.value.account, isFake: false } });
      break;
    default:
      logger.warn("received an unknown GET_UPDATES event type", { isOld });
  }
  return effects;
};

export const IncomingRpc = {
  decode,
  routeUpdate,
  createDedup,
  shapeFields,
  responseSchema: (action: ActionType): DescMessage | undefined => RESPONSE_TYPES.get(action),
} as const;

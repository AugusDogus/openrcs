import { create } from "@bufbuild/protobuf";
import { Result } from "better-result";
import { CursorSchema, type Cursor } from "@/gen/gmproto/client_pb";
import type { Database } from "@/lib/db/client";
import type { GMClient } from "@/lib/gm/client";
import { GMMedia, type GMMediaError, type MediaCredentials } from "@/lib/gm/media";
import { GMMessage, type PlainMedia } from "@/lib/gm/message";
import type { RcsContext } from "./context";
import {
  GmFailure,
  RcsMediaError,
  type RcsPhoneAccessError,
  type RcsPhoneError,
  type RcsStorageError,
} from "./errors";
import { withPhone, type WithPhoneOptions } from "./phone";
import { Store, type StoredMessage } from "./store";

/**
 * Attachments. Google keeps each attachment encrypted under a key that
 * travels inside its message, so the key is stored with the message (sealed
 * by the DEK like the rest of its content). Messages stored before keys were
 * kept are fetched from the phone again on first use.
 */

export type MediaInfo = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly mediaId: string;
  readonly mimeType: string;
  readonly name: string;
  /** Size the phone reported; 0 when it reported none. */
  readonly size: number;
};

/** Everything a later download needs, with no further access to the vault. Secret. */
export type MediaGrant = {
  readonly mediaId: string;
  readonly key: Uint8Array;
  readonly credentials: MediaCredentials;
};

export type OpenedMedia = {
  readonly info: MediaInfo;
  readonly grant: MediaGrant;
  /** The decrypted bytes, when `inline` asked for them and they fit. */
  readonly bytes: Uint8Array | null;
};

export type OpenMediaOptions = {
  /** Download the bytes too when the type is listed and they are at most `maxBytes`. */
  readonly inline?: { readonly mimeTypes: readonly string[]; readonly maxBytes: number };
  readonly signal?: AbortSignal;
  /** Passed to `withPhone` (tests inject `createClient`). */
  readonly phone?: WithPhoneOptions;
};

const REFETCH_PAGE = 50;
/** Pages read from the newest message when the direct lookup misses. */
const REFETCH_MAX_PAGES = 6;

const mediaError = (
  userId: string,
  reason: RcsMediaError["reason"],
  message: string,
  status: number | null = null,
): RcsMediaError => new RcsMediaError({ userId, reason, status, needsRepair: false, message });

const downloadFailure = (userId: string, error: GMMediaError): RcsMediaError => {
  const status = error._tag === "GMHttpError" ? error.status : null;
  if (status === 404 || status === 410) {
    return mediaError(
      userId,
      "download",
      "Google no longer has this attachment, so it cannot be downloaded. The message itself is unchanged; the attachment may still open in Google Messages on the phone.",
      status,
    );
  }
  if (status === 401 || status === 403) {
    return mediaError(
      userId,
      "download",
      `Google refused to hand over this attachment (HTTP ${status}). Nothing was returned. Try again; if it keeps failing, pair the phone again from the openrcs dashboard.`,
      status,
    );
  }
  return mediaError(userId, "download", `The attachment could not be downloaded. ${GmFailure.describe(error)}`, status);
};

/**
 * Fetch the message from the phone again (storing every message of the pages
 * read, keys included) and return its attachment, or null when the phone no
 * longer lists the message. One page starting at the message itself, then a
 * few pages from the newest message in case that cursor is not honoured.
 */
const refetch = async (
  client: GMClient,
  db: Database,
  ctx: RcsContext,
  target: StoredMessage,
  signal: AbortSignal | undefined,
): Promise<Result<PlainMedia | null, RcsPhoneError | RcsStorageError>> => {
  const newer = await Store.nextNewerMessage(db, ctx.userId, target.conversationId, target.timestampMs);
  if (newer.isErr()) return Result.err(newer.error);
  // A cursor names the last item already seen, so the page starts at the target.
  const anchor =
    newer.value === null
      ? undefined
      : create(CursorSchema, { lastItemID: newer.value.messageId, lastItemTimestamp: BigInt(newer.value.timestampMs) });
  const attempts: { cursor: Cursor | undefined; pages: number }[] =
    anchor === undefined ? [{ cursor: undefined, pages: REFETCH_MAX_PAGES }] : [{ cursor: anchor, pages: 1 }, { cursor: undefined, pages: REFETCH_MAX_PAGES }];
  for (const attempt of attempts) {
    let cursor = attempt.cursor;
    for (let page = 0; page < attempt.pages && signal?.aborted !== true; page += 1) {
      const response = await client.fetchMessages({ conversationId: target.conversationId, count: REFETCH_PAGE, cursor });
      if (response.isErr()) return Result.err(GmFailure.toPhoneError(ctx.userId, "media.fetchMessages", response.error));
      const messages = response.value.messages.map(GMMessage.toPlain);
      if (messages.length > 0) {
        const stored = await Store.upsertMessages(db, ctx, messages);
        if (stored.isErr()) return Result.err(stored.error);
      }
      const found = messages.find((m) => m.messageId === target.messageId);
      if (found !== undefined) return Result.ok(found.media);
      const oldest = Math.min(...messages.map((m) => m.timestampMs));
      if (messages.length === 0 || oldest < target.timestampMs || response.value.cursor === undefined) break;
      cursor = response.value.cursor;
    }
  }
  return Result.ok(null);
};

const noKey = (userId: string): RcsMediaError =>
  mediaError(
    userId,
    "noKey",
    "The phone did not provide a key for this attachment, so it cannot be downloaded. The message may have been deleted on the phone, or the attachment was never synced to Google Messages for web.",
  );

/**
 * Resolve the attachment of a stored message into a download grant, and
 * optionally its decrypted bytes. Connects to the phone session (for a fresh
 * Google token, and to fetch the key when the stored message has none).
 */
const open = async (
  db: Database,
  ctx: RcsContext,
  messageId: string,
  opts: OpenMediaOptions = {},
): Promise<Result<OpenedMedia, RcsMediaError | RcsPhoneAccessError>> => {
  const stored = await Store.getMessage(db, ctx, messageId);
  if (stored.isErr()) return Result.err(stored.error);
  const message = stored.value;
  if (message === null) {
    return Result.err(
      mediaError(
        ctx.userId,
        "noMessage",
        `No stored message has the id "${messageId}". Use a message_id from get_messages or search_messages (sync first if the message is new).`,
      ),
    );
  }
  if (message.media === null) {
    return Result.err(mediaError(ctx.userId, "noMedia", `Message ${messageId} has no attachment (its \`media\` is null).`));
  }
  const listed = message.media;

  return withPhone(
    db,
    ctx,
    async (client): Promise<Result<OpenedMedia, RcsMediaError | RcsPhoneError | RcsStorageError>> => {
      let media: PlainMedia = listed;
      if (media.key === null || media.mediaId === "") {
        const fetched = await refetch(client, db, ctx, message, opts.signal);
        if (fetched.isErr()) return Result.err(fetched.error);
        if (fetched.value === null) return Result.err(noKey(ctx.userId));
        media = fetched.value;
      }
      if (media.mediaId === "") {
        return Result.err(
          mediaError(
            ctx.userId,
            "notUploaded",
            "The phone has not uploaded this attachment yet. Open the conversation in Google Messages on the phone so it downloads, then try again.",
          ),
        );
      }
      if (media.key === null) return Result.err(noKey(ctx.userId));

      const info: MediaInfo = {
        messageId: message.messageId,
        conversationId: message.conversationId,
        mediaId: media.mediaId,
        mimeType: media.mimeType,
        name: media.name,
        size: media.size,
      };
      const key = new Uint8Array(Buffer.from(media.key, "base64"));
      const grant: MediaGrant = { mediaId: media.mediaId, key, credentials: GMMedia.credentials(client.authData) };
      const inline = opts.inline;
      if (inline === undefined || !inline.mimeTypes.includes(media.mimeType) || media.size > inline.maxBytes) {
        return Result.ok({ info, grant, bytes: null });
      }
      const stream = await client.downloadMedia({ mediaId: media.mediaId, key, signal: opts.signal });
      if (stream.isErr()) return Result.err(downloadFailure(ctx.userId, stream.error));
      const bytes = await GMMedia.collect(stream.value, inline.maxBytes);
      if (bytes.isErr()) return Result.err(downloadFailure(ctx.userId, bytes.error));
      return Result.ok({ info, grant, bytes: bytes.value });
    },
    { operation: "media", signal: opts.signal, ...opts.phone },
  );
};

export const Media = { open, downloadFailure } as const;

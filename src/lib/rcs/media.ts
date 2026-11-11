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
  /** Size the phone reported for the original; 0 when it reported none. */
  readonly size: number;
  /** True when this is the reduced-size preview: the phone did not provide the original. */
  readonly preview: boolean;
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
  /** How long to wait for the phone to upload an original it only sent a preview of. Default 20 s, polled every 1.5 s. */
  readonly original?: { readonly waitMs: number; readonly pollMs: number };
  readonly signal?: AbortSignal;
  /** Passed to `withPhone` (tests inject `createClient`). */
  readonly phone?: WithPhoneOptions;
};

/** The direct lookup starts at the message itself (or at the newest message), so a short page is enough. */
const ANCHORED_PAGE = 5;
const REFETCH_PAGE = 50;
/** Pages read from the newest message when the direct lookup misses. */
const REFETCH_MAX_PAGES = 6;
const DEFAULT_ORIGINAL_WAIT = { waitMs: 20_000, pollMs: 1_500 } as const;

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
 * longer lists the message. One short page starting at the message itself,
 * then a few pages from the newest message in case that cursor is not honoured.
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
  const attempts: { cursor: Cursor | undefined; pages: number; count: number }[] = [
    { cursor: anchor, pages: 1, count: ANCHORED_PAGE },
    { cursor: undefined, pages: REFETCH_MAX_PAGES, count: REFETCH_PAGE },
  ];
  for (const attempt of attempts) {
    let cursor = attempt.cursor;
    for (let page = 0; page < attempt.pages && signal?.aborted !== true; page += 1) {
      const response = await client.fetchMessages({ conversationId: target.conversationId, count: attempt.count, cursor });
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the phone to upload the original of a part it only sent a preview of,
 * then re-read the message until it carries the original. Null when the phone
 * refuses or does not deliver in time; the preview stays usable.
 */
const requestOriginal = async (
  client: GMClient,
  db: Database,
  ctx: RcsContext,
  target: StoredMessage,
  partId: string,
  opts: OpenMediaOptions,
): Promise<PlainMedia | null> => {
  const requested = await client.requestFullSizeImage(target.messageId, partId);
  if (requested.isErr()) {
    console.warn(`[rcs:media] full-size request failed: ${requested.error._tag}`);
    return null;
  }
  const { waitMs, pollMs } = opts.original ?? DEFAULT_ORIGINAL_WAIT;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && opts.signal?.aborted !== true) {
    await sleep(pollMs);
    const fetched = await refetch(client, db, ctx, target, opts.signal);
    if (fetched.isErr()) return null;
    const media = fetched.value;
    if (media !== null && !media.thumbnail && media.mediaId !== "" && media.key !== null) return media;
  }
  return null;
};

const noKey = (userId: string): RcsMediaError =>
  mediaError(
    userId,
    "noKey",
    "The phone did not provide a key for this attachment, so it cannot be downloaded. The message may have been deleted on the phone, or the attachment was never synced to Google Messages for web.",
  );

/**
 * Resolve the attachment of a stored message into a download grant, and
 * optionally its decrypted bytes. Connects to the phone session for a fresh
 * Google token, to fetch the key when the stored message has none, and to
 * have the phone upload the original when Google only holds a preview.
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
      // Stored before keys and part ids were kept, or still a preview: read the phone's current copy.
      if (media.key === null || media.mediaId === "" || media.partId === null || media.thumbnail) {
        const fetched = await refetch(client, db, ctx, message, opts.signal);
        if (fetched.isErr()) return Result.err(fetched.error);
        if (fetched.value !== null) media = fetched.value;
      }
      if ((media.thumbnail || media.mediaId === "") && media.partId !== null) {
        media = (await requestOriginal(client, db, ctx, message, media.partId, opts)) ?? media;
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
        preview: media.thumbnail,
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

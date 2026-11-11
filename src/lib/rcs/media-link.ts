import { createSecretKey, hkdfSync, randomBytes } from "node:crypto";
import { Result, TaggedError } from "better-result";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { verification } from "@/lib/db/auth-schema";
import type { Database } from "@/lib/db/client";
import { Env } from "@/lib/env";
import { GMMedia } from "@/lib/gm/media";
import type { FetchFn } from "@/lib/gm/http";
import { SecretBox } from "@/lib/secret-box";
import { Base64Url } from "@/lib/vault/base64url";
import { VaultConfig } from "@/lib/vault/config";
import { RcsStorageError } from "./errors";
import type { MediaGrant, MediaInfo } from "./media";

/**
 * Short-lived download links for attachments (docs/security.md "Attachments").
 * A link is `/api/media/<id>.<secret>`. The row `media-link:<id>` in Better
 * Auth's `verification` table holds what the download needs (Google's media
 * id, the attachment key and the session's tachyon token), sealed with a key
 * derived from the link's secret and KEY_PEPPER. The secret is never stored,
 * so neither the database nor the server key opens a row without the link,
 * and a link stops working when its row expires.
 */

export const MEDIA_LINK_TTL_MS = 10 * 60 * 1000;
const IDENTIFIER = "openrcs-media-link";
const VERSION = "m1";
const ID_BYTES = 16;
const SECRET_BYTES = 32;

export type MediaLinkConfig = {
  readonly db: Database;
  /** Public origin without a trailing slash. */
  readonly origin: string;
  /** KEY_PEPPER bytes. Never log. */
  readonly pepper: Uint8Array;
  /** Unix epoch milliseconds. */
  readonly now: () => number;
};

/** The link is malformed, unknown, expired, or its secret does not open the row. */
export class MediaLinkInvalidError extends TaggedError("MediaLinkInvalidError")<{
  reason: "malformed" | "unknown" | "expired" | "unreadable";
  message: string;
}> {}

const payloadSchema = z.object({
  v: z.literal(1),
  mediaId: z.string().min(1),
  key: z.string().min(1),
  token: z.string(),
  network: z.string(),
  mimeType: z.string(),
  name: z.string(),
});

export type MediaLinkTarget = {
  readonly grant: MediaGrant;
  readonly mimeType: string;
  readonly name: string;
};

const rowId = (id: string): string => `media-link:${id}`;

const boxFor = (pepper: Uint8Array, secret: Uint8Array): SecretBox => ({
  key: createSecretKey(new Uint8Array(hkdfSync("sha256", secret, pepper, "openrcs/media-link/v1", 32))),
});

const invalid = (reason: MediaLinkInvalidError["reason"]) =>
  new MediaLinkInvalidError({
    reason,
    message:
      "This download link is invalid or has expired (links last 10 minutes). Nothing was downloaded. Ask the agent to call get_media again for a new link.",
  });

const storageError = (operation: string, cause: unknown) =>
  new RcsStorageError({
    operation,
    userId: "",
    cause,
    message: "openrcs could not reach its database, so the download link was not handled. Try again in a moment.",
  });

/** Store a sealed grant and return its link. Also drops expired links. */
const create = async (
  config: MediaLinkConfig,
  info: Pick<MediaInfo, "mimeType" | "name">,
  grant: MediaGrant,
): Promise<Result<{ url: string; expiresAt: Date }, RcsStorageError>> => {
  const id = Base64Url.encode(randomBytes(ID_BYTES));
  const secret = new Uint8Array(randomBytes(SECRET_BYTES));
  const now = config.now();
  const expiresAt = new Date(now + MEDIA_LINK_TTL_MS);
  const payload: z.infer<typeof payloadSchema> = {
    v: 1,
    mediaId: grant.mediaId,
    key: Buffer.from(grant.key).toString("base64"),
    token: Buffer.from(grant.credentials.tachyonAuthToken).toString("base64"),
    network: grant.credentials.network,
    mimeType: info.mimeType,
    name: info.name,
  };
  const value = SecretBox.seal(boxFor(config.pepper, secret), JSON.stringify(payload), {
    associatedData: id,
    version: VERSION,
  });
  const stored = await Result.tryPromise({
    try: () =>
      config.db.batch([
        config.db
          .delete(verification)
          .where(and(eq(verification.identifier, IDENTIFIER), lt(verification.expiresAt, new Date(now)))),
        config.db.insert(verification).values({
          id: rowId(id),
          identifier: IDENTIFIER,
          value,
          expiresAt,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        }),
      ]),
    catch: (cause) => storageError("mediaLink.create", cause),
  });
  if (stored.isErr()) return Result.err(stored.error);
  return Result.ok({ url: `${config.origin}/api/media/${id}.${Base64Url.encode(secret)}`, expiresAt });
};

/** Resolve the `<id>.<secret>` part of a link. */
const open = async (
  config: MediaLinkConfig,
  token: string,
): Promise<Result<MediaLinkTarget, MediaLinkInvalidError | RcsStorageError>> => {
  const [id, secretPart, ...rest] = token.split(".");
  const secret = secretPart === undefined ? undefined : Base64Url.decode(secretPart);
  if (id === undefined || rest.length > 0 || Base64Url.decode(id)?.byteLength !== ID_BYTES || secret?.byteLength !== SECRET_BYTES) {
    return Result.err(invalid("malformed"));
  }
  const read = await Result.tryPromise({
    try: () =>
      config.db
        .select({ value: verification.value, expiresAt: verification.expiresAt })
        .from(verification)
        .where(and(eq(verification.id, rowId(id)), eq(verification.identifier, IDENTIFIER)))
        .limit(1),
    catch: (cause) => storageError("mediaLink.open", cause),
  });
  if (read.isErr()) return Result.err(read.error);
  const [row] = read.value;
  if (row === undefined) return Result.err(invalid("unknown"));
  if (row.expiresAt.getTime() <= config.now()) return Result.err(invalid("expired"));
  const opened = SecretBox.open(boxFor(config.pepper, secret), row.value, { associatedData: id, version: VERSION });
  if (opened.isErr()) return Result.err(invalid("unreadable"));
  const json = Result.try((): unknown => JSON.parse(opened.value));
  const parsed = payloadSchema.safeParse(json.isOk() ? json.value : undefined);
  if (!parsed.success) return Result.err(invalid("unreadable"));
  const payload = parsed.data;
  return Result.ok({
    grant: {
      mediaId: payload.mediaId,
      key: new Uint8Array(Buffer.from(payload.key, "base64")),
      credentials: {
        tachyonAuthToken: new Uint8Array(Buffer.from(payload.token, "base64")),
        network: payload.network,
      },
    },
    mimeType: payload.mimeType,
    name: payload.name,
  });
};

const text = (status: number, message: string): Response =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Always an attachment, never rendered: the file comes from whoever sent the
 * message, and this origin also serves the dashboard.
 */
const downloadHeaders = (target: MediaLinkTarget): Record<string, string> => {
  const mime = target.mimeType.toLowerCase();
  const name = target.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "attachment";
  return {
    "content-type": MIME_PATTERN.test(mime) ? mime : "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
};

/** `GET /api/media/<token>`: stream the decrypted attachment from Google. */
const respond = async (
  config: MediaLinkConfig,
  token: string,
  opts: { readonly signal?: AbortSignal; readonly fetch?: FetchFn } = {},
): Promise<Response> => {
  const target = await open(config, token);
  if (target.isErr()) {
    if (target.error._tag === "RcsStorageError") {
      console.error(`[media] ${target.error.operation} failed`);
      return text(503, target.error.message);
    }
    return text(404, target.error.message);
  }
  const stream = await GMMedia.download({ fetch: opts.fetch ?? fetch, ...target.value.grant, signal: opts.signal });
  if (stream.isErr()) {
    const status = stream.error._tag === "GMHttpError" ? stream.error.status : null;
    console.warn(`[media] download failed: ${stream.error._tag}${status === null ? "" : ` status=${status}`}`);
    return text(
      502,
      "Google did not return this attachment, so nothing was downloaded. Try the link again; if it keeps failing, ask the agent to call get_media again.",
    );
  }
  return new Response(stream.value, { status: 200, headers: downloadHeaders(target.value) });
};

export const MediaLink = {
  /** From KEY_PEPPER and BETTER_AUTH_URL. Throws `InvalidEnvError` naming what is missing. */
  configFromEnv: (db: Database): MediaLinkConfig => {
    const vault = VaultConfig.fromEnv();
    return { db, origin: new URL(Env.auth().BETTER_AUTH_URL).origin, pepper: vault.pepper, now: vault.now };
  },
  create,
  open,
  respond,
} as const;

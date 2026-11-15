import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { describePhoneError } from "@/lib/rcs/phone";
import { Media } from "@/lib/rcs/media";
import { MediaLink } from "@/lib/rcs/media-link";
import type { RcsToolRegistrar } from "../context";
import { ToolScope } from "../scopes";
import {
  fail,
  isCallToolResult,
  logToolError,
  requirePhone,
  requireSession,
  TOOL_LEASE_WAIT_MS,
} from "./shared";

/**
 * Images at most this large come back inline (base64 adds a third). Larger
 * ones come back as a download link, so one tool result stays a size every
 * MCP client accepts.
 */
export const INLINE_IMAGE_MAX_BYTES = 3_000_000;

const inputSchema = z.object({
  message_id: z
    .string()
    .min(1)
    .max(200)
    .describe("message_id of a message whose `media` is not null, from get_messages or search_messages."),
  as_link: z
    .boolean()
    .optional()
    .describe("Return a download link even for an image (default false). Use it when you cannot view image content."),
});

const outputSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  media_id: z.string(),
  mime_type: z.string(),
  name: z.string(),
  /** Bytes returned inline, else the size the phone reported (0 when unknown). */
  size: z.number(),
  /** True when only the reduced-size preview was available (the phone did not provide the original in time). */
  preview: z.boolean(),
  /** "image": the image is in this result's content. "link": fetch download_url. */
  delivery: z.enum(["image", "link"]),
  download_url: z.url().nullable(),
  download_expires_at: z.iso.datetime().nullable(),
});

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** The image type by its leading bytes, for the types MCP clients display. */
const sniffImage = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
};

const INLINE_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"] as const;

export const registerGetMediaTool: RcsToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_media",
    {
      title: "Get media",
      description:
        "Fetches the attachment of one message (a message whose `media` is not null in get_messages or search_messages), asking the phone for the original when only a preview has been synced (this can take up to about 30 seconds). PNG, JPEG, GIF and WebP images up to 3 MB are returned as image content you can look at. Every other attachment (video, audio, HEIC, files, larger images) is returned as download_url, a link that works without credentials for 10 minutes; give it to the user or fetch it. Read-only: nothing is sent and the message is not marked read. Needs the phone to be paired.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async ({ message_id, as_link }): Promise<CallToolResult> => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      const db = getDb();
      const session = await requireSession(db, ctx, "get_media");
      if (isCallToolResult(session)) return session;
      const unreachable = requirePhone(session);
      if (unreachable) return unreachable;

      const opened = await Media.open(db, session.rcs, message_id, {
        inline: as_link === true ? undefined : { mimeTypes: INLINE_MIME_TYPES, maxBytes: INLINE_IMAGE_MAX_BYTES },
        phone: { lease: { waitMs: TOOL_LEASE_WAIT_MS }, ...ctx.testing?.phone },
      });
      if (opened.isErr()) {
        logToolError("get_media", opened.error);
        return fail(describePhoneError(opened.error));
      }
      const { info, grant, bytes } = opened.value;
      const base = {
        message_id: info.messageId,
        conversation_id: info.conversationId,
        media_id: info.mediaId,
        name: info.name,
        preview: info.preview,
      };
      const label = info.name === "" ? "attachment" : info.name;
      const previewNote = info.preview
        ? " This is the reduced-size preview: the phone has not provided the original yet. Call get_media again in a minute for the full-size file."
        : "";

      const imageType = bytes === null ? null : sniffImage(bytes);
      if (bytes !== null && imageType !== null) {
        const output: z.infer<typeof outputSchema> = {
          ...base,
          mime_type: imageType,
          size: bytes.length,
          delivery: "image",
          download_url: null,
          download_expires_at: null,
        };
        return {
          content: [
            { type: "text", text: `${label} (${imageType}, ${bytes.length} bytes) from message ${info.messageId}.${previewNote}` },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: imageType },
          ],
          structuredContent: output,
        };
      }

      const link = await MediaLink.create(ctx.testing?.mediaLink ?? MediaLink.configFromEnv(db), info, grant);
      if (link.isErr()) {
        logToolError("get_media", link.error);
        return fail(link.error.message);
      }
      const output: z.infer<typeof outputSchema> = {
        ...base,
        mime_type: info.mimeType,
        size: info.size,
        delivery: "link",
        download_url: link.value.url,
        download_expires_at: link.value.expiresAt.toISOString(),
      };
      const why =
        as_link === true
          ? ""
          : info.mimeType.startsWith("image/")
            ? " It is not returned inline because it is larger than 3 MB or not PNG, JPEG, GIF or WebP."
            : "";
      return {
        content: [
          {
            type: "text",
            text: `${label} (${info.mimeType}${info.size > 0 ? `, ${info.size} bytes` : ""}) from message ${info.messageId}: download it from ${link.value.url} (no credentials needed, valid until ${output.download_expires_at}).${why}${previewNote}`,
          },
        ],
        structuredContent: output,
      };
    },
  );
};

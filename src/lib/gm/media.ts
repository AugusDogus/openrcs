import { randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { Result } from "better-result";

import { DownloadAttachmentRequestSchema } from "@/gen/gmproto/client_pb";

import { AuthData } from "./auth-data";
import { configVersion, UPLOAD_MEDIA_URL, uploadHeaders } from "./constants";
import { AesGcmHelper, type AesGcmDecryptError } from "./crypto/aes-gcm";
import { GMAbortedError, GMDecodeError, GMHttpError, GMNetworkError } from "./errors";
import { GMHttp, STREAM_HEADERS_TIMEOUT_MS, type FetchFn } from "./http";

// libgm media.go DownloadMedia: GET the upload endpoint with a base64
// DownloadAttachmentRequest in x-goog-download-metadata, then decrypt the body
// (crypto/aes-gcm.ts) with the key from the message's MediaContent. The
// request carries only the tachyon token, no cookies.

const ACTION = "downloading media";

/** What Google needs to authorize a media download. Never log. */
export type MediaCredentials = {
  readonly tachyonAuthToken: Uint8Array;
  /** AuthMessage.network ("GDitto" for Google-account sessions, "" otherwise). */
  readonly network: string;
};

export type MediaDownloadRequest = {
  readonly fetch: FetchFn;
  readonly credentials: MediaCredentials;
  readonly mediaId: string;
  /** MediaContent.decryptionKey (32 bytes). */
  readonly key: Uint8Array;
  readonly signal?: AbortSignal;
  /** Time allowed for the response headers. Default 20 s. */
  readonly headersTimeoutMs?: number;
};

export type GMMediaError = GMHttpError | GMNetworkError | GMAbortedError | GMDecodeError;

const decodeError = (error: { readonly message: string }): GMDecodeError =>
  new GMDecodeError({ action: ACTION, message: error.message, cause: error });

const networkError = (cause: unknown, timedOut: boolean): GMNetworkError =>
  new GMNetworkError({
    action: ACTION,
    reason: timedOut ? "timeout" : "network",
    message: timedOut
      ? "Google did not start sending the attachment in time. Nothing was returned; try again."
      : "Could not reach Google while downloading the attachment (network error). Nothing was returned; try again.",
    cause,
  });

const aborted = (): GMAbortedError =>
  new GMAbortedError({ action: ACTION, message: `Stopped ${ACTION} because the caller cancelled the operation.` });

const downloadMetadata = (credentials: MediaCredentials, mediaId: string): string =>
  Buffer.from(
    toBinary(
      DownloadAttachmentRequestSchema,
      create(DownloadAttachmentRequestSchema, {
        info: { attachmentID: mediaId, encrypted: true },
        authData: {
          requestID: randomUUID(),
          tachyonAuthToken: credentials.tachyonAuthToken,
          network: credentials.network,
          configVersion: configVersion(),
        },
      }),
    ),
  ).toString("base64");

/**
 * Start a download and return the decrypted bytes as a stream. A chunk that
 * fails to decrypt errors the stream with a GMDecodeError; a dropped
 * connection errors it with whatever fetch threw.
 */
const download = async (req: MediaDownloadRequest): Promise<Result<ReadableStream<Uint8Array>, GMMediaError>> => {
  const made = AesGcmHelper.decryptor(req.key);
  if (made.isErr()) return Result.err(decodeError(made.error));
  const decryptor = made.value;
  if (req.signal?.aborted) return Result.err(aborted());

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.headersTimeoutMs ?? STREAM_HEADERS_TIMEOUT_MS);
  // Stays attached after the headers arrive: the caller's signal bounds the body too.
  req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await req.fetch(UPLOAD_MEDIA_URL, {
      method: "GET",
      headers: uploadHeaders(downloadMetadata(req.credentials, req.mediaId)),
      signal: controller.signal,
    });
  } catch (cause) {
    return Result.err(req.signal?.aborted ? aborted() : networkError(cause, timedOut));
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status >= 300 || response.body === null) {
    controller.abort();
    return Result.err(GMHttp.httpError(response.status, ACTION));
  }

  const emit = (
    parts: Result<Uint8Array[], AesGcmDecryptError>,
    out: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (parts.isErr()) {
      out.error(decodeError(parts.error));
      return;
    }
    for (const part of parts.value) out.enqueue(part);
  };
  return Result.ok(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, out) => emit(decryptor.push(chunk), out),
        flush: (out) => emit(decryptor.finish(), out),
      }),
    ),
  );
};

/**
 * Read a download stream into memory. `null` when it holds more than
 * `maxBytes` (the stream is cancelled).
 */
const collect = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Result<Uint8Array | null, GMDecodeError | GMNetworkError>> => {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return Result.ok(null);
      }
      parts.push(value);
    }
  } catch (cause) {
    return Result.err(cause instanceof GMDecodeError ? cause : networkError(cause, false));
  }
  return Result.ok(new Uint8Array(Buffer.concat(parts)));
};

export const GMMedia = {
  /** Credentials of a paired session (an empty token when it has none; Google then answers 401). */
  credentials: (authData: AuthData): MediaCredentials => ({
    tachyonAuthToken: authData.tachyonAuthToken ?? new Uint8Array(0),
    network: AuthData.authNetwork(authData),
  }),
  download,
  collect,
} as const;

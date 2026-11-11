import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { DownloadAttachmentRequestSchema } from "@/gen/gmproto/client_pb";
import { UPLOAD_MEDIA_URL } from "./constants";
import { AesGcmHelper } from "./crypto/aes-gcm";
import type { FetchFn } from "./http";
import { GMMedia } from "./media";

const key = new Uint8Array(32).fill(7);
const credentials = { tachyonAuthToken: new Uint8Array([1, 2, 3]), network: "GDitto" };
const plain = new Uint8Array(80_000).map((_, i) => i % 253);
const sealed = AesGcmHelper.encrypt(key, plain).unwrap();

const serving = (body: Uint8Array, status = 200) => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: FetchFn = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(status === 200 ? new Uint8Array(body) : "nope", { status });
  };
  return { fetch, requests };
};

describe("GMMedia.download (libgm DownloadMedia)", () => {
  test("sends the download metadata without cookies and decrypts the body", async () => {
    const google = serving(sealed);
    const stream = (await GMMedia.download({ fetch: google.fetch, credentials, mediaId: "media-1", key })).unwrap();
    const bytes = (await GMMedia.collect(stream, 1_000_000)).unwrap();
    expect(bytes === null ? -1 : Buffer.compare(bytes, plain)).toBe(0);

    const [request] = google.requests;
    expect(request?.url).toBe(UPLOAD_MEDIA_URL);
    expect(request?.init?.method).toBe("GET");
    const headers = new Headers(request?.init?.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    const metadata = fromBinary(
      DownloadAttachmentRequestSchema,
      new Uint8Array(Buffer.from(headers.get("x-goog-download-metadata") ?? "", "base64")),
    );
    expect(metadata.info).toMatchObject({ attachmentID: "media-1", encrypted: true });
    expect(metadata.authData?.network).toBe("GDitto");
    expect([...(metadata.authData?.tachyonAuthToken ?? [])]).toEqual([1, 2, 3]);
    expect(metadata.authData?.requestID).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.authData?.configVersion).toBeDefined();
  });

  test("a refused download is a GMHttpError with Google's status", async () => {
    const result = await GMMedia.download({ fetch: serving(sealed, 404).fetch, credentials, mediaId: "gone", key });
    expect(result.isErr() && result.error).toMatchObject({ _tag: "GMHttpError", status: 404 });
  });

  test("a body that fails to decrypt errors the stream instead of yielding partial bytes", async () => {
    const corrupt = sealed.slice();
    corrupt[40_000] = (corrupt[40_000] ?? 0) ^ 1;
    const stream = (await GMMedia.download({ fetch: serving(corrupt).fetch, credentials, mediaId: "m", key })).unwrap();
    const collected = await GMMedia.collect(stream, 1_000_000);
    expect(collected.isErr() && collected.error._tag).toBe("GMDecodeError");
  });

  test("a wrong-length key is rejected before any request", async () => {
    const google = serving(sealed);
    const result = await GMMedia.download({ fetch: google.fetch, credentials, mediaId: "m", key: new Uint8Array(5) });
    expect(result.isErr() && result.error._tag).toBe("GMDecodeError");
    expect(google.requests).toHaveLength(0);
  });

  test("collect stops at the byte cap", async () => {
    const stream = (await GMMedia.download({ fetch: serving(sealed).fetch, credentials, mediaId: "m", key })).unwrap();
    expect((await GMMedia.collect(stream, 10_000)).unwrap()).toBeNull();
  });
});

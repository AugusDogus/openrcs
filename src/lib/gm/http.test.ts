import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";

import { ErrorResponseSchema, TokenDataSchema } from "@/gen/gmproto/authentication_pb";

import { AuthData } from "./auth-data";
import { Clock } from "./clock";
import { CONTENT_TYPE_PBLITE, CONTENT_TYPE_PROTOBUF, MESSAGES_BASE_URL } from "./constants";
import { sapisidHash } from "./crypto/sapisid";
import { GMHttp, type FetchFn, type HttpContext } from "./http";
import { GMLogger } from "./logger";
import { Pblite } from "./pblite";

const ctxWith = (fetchFn: FetchFn, cookies: Record<string, string> | null): { ctx: HttpContext; changes: () => number } => {
  const authData = AuthData.createForPairing();
  authData.cookies = cookies;
  let changes = 0;
  return {
    ctx: { fetch: fetchFn, authData, logger: GMLogger.noop, clock: Clock.real, onCookiesChanged: () => changes++ },
    changes: () => changes,
  };
};

const respond =
  (body: BodyInit | null, init: ResponseInit): FetchFn =>
  async () =>
    new Response(body, init);

const token = create(TokenDataSchema, { tachyonAuthToken: Uint8Array.of(9, 8, 7), TTL: 5n });

describe("GMHttp.buildHeaders", () => {
  test("relay headers only, without cookies", () => {
    const h = GMHttp.buildHeaders(CONTENT_TYPE_PBLITE, null, new Date());
    expect(h.get("content-type")).toBe(CONTENT_TYPE_PBLITE);
    expect(h.get("origin")).toBe(MESSAGES_BASE_URL);
    expect(h.has("cookie")).toBe(false);
    expect(h.has("authorization")).toBe(false);
  });

  test("cookies and SAPISIDHASH for the messages.google.com origin", () => {
    const now = new Date(1_762_435_200_000);
    const h = GMHttp.buildHeaders(CONTENT_TYPE_PBLITE, { SID: "a", SAPISID: "s/1" }, now);
    expect(h.get("cookie")).toBe("SID=a; SAPISID=s/1");
    expect(h.get("authorization")).toBe(sapisidHash(MESSAGES_BASE_URL, "s/1", 1_762_435_200));
  });

  test("cookies whose names are not header tokens are left out instead of failing the request", () => {
    // Node's Headers error for such a value quotes the whole Cookie header, secrets included.
    const h = GMHttp.buildHeaders(CONTENT_TYPE_PBLITE, { SID: "a", "bad\u0000name": "x", "emoji😀": "y", "sp ace": "z", SAPISID: "s" }, new Date());
    expect(h.get("cookie")).toBe("SID=a; SAPISID=s");
  });
});

describe("GMHttp.post Set-Cookie handling", () => {
  const rotating = (): FetchFn => async () => {
    const headers = new Headers({ "content-type": CONTENT_TYPE_PBLITE });
    headers.append("set-cookie", "SIDCC=new; Path=/; Secure");
    headers.append("set-cookie", "SID=same; Domain=.google.com");
    headers.append("set-cookie", 'QUOTED="q"; Path=/');
    headers.append("set-cookie", "bad name=x");
    return new Response("[]", { headers });
  };

  test("updates the cookie map and reports a change once when a value changed", async () => {
    const { ctx, changes } = ctxWith(rotating(), { SID: "same", SIDCC: "old" });
    (await GMHttp.post(ctx, { url: "https://x/y", action: "t", contentType: CONTENT_TYPE_PBLITE, body: "[]" })).unwrap();
    expect(ctx.authData.cookies).toEqual({ SID: "same", SIDCC: "new", QUOTED: "q" });
    expect(changes()).toBe(1);
  });

  test("does not report a change when every value is the same", async () => {
    const { ctx, changes } = ctxWith(rotating(), { SID: "same", SIDCC: "new", QUOTED: "q" });
    (await GMHttp.post(ctx, { url: "https://x/y", action: "t", contentType: CONTENT_TYPE_PBLITE, body: "[]" })).unwrap();
    expect(changes()).toBe(0);
  });

  test("ignores Set-Cookie when the session has no cookie map (QR sessions)", async () => {
    const { ctx, changes } = ctxWith(rotating(), null);
    (await GMHttp.post(ctx, { url: "https://x/y", action: "t", contentType: CONTENT_TYPE_PBLITE, body: "[]" })).unwrap();
    expect(ctx.authData.cookies).toBeNull();
    expect(changes()).toBe(0);
  });
});

describe("GMHttp.request typed decoding", () => {
  const request = (fetchFn: FetchFn) =>
    GMHttp.request(ctxWith(fetchFn, null).ctx, {
      url: "https://x/y",
      action: "testing",
      contentType: CONTENT_TYPE_PROTOBUF,
      requestSchema: TokenDataSchema,
      message: token,
      responseSchema: TokenDataSchema,
    });

  test.each([
    ["binary protobuf", new Uint8Array(toBinary(TokenDataSchema, token)), CONTENT_TYPE_PROTOBUF],
    ["pblite", Pblite.marshal(TokenDataSchema, token), `${CONTENT_TYPE_PBLITE}; charset=UTF-8`],
    ["text/plain pblite", Pblite.marshal(TokenDataSchema, token), "text/plain"],
  ])("decodes %s by content type", async (_, body, type) => {
    const res = await request(respond(body, { headers: { "content-type": type } }));
    expect(res.unwrap().tachyonAuthToken).toEqual(Uint8Array.of(9, 8, 7));
  });

  test("an unknown content type is a decode error", async () => {
    const res = await request(respond("<html>", { headers: { "content-type": "text/html" } }));
    expect(res.isErr() && res.error._tag).toBe("GMDecodeError");
  });

  test("non-2xx with an ErrorResponse message is a GMRequestError", async () => {
    const body = Pblite.marshal(ErrorResponseSchema, create(ErrorResponseSchema, { type: 5n, message: "Requested entity was not found." }));
    const res = await request(respond(body, { status: 404, headers: { "content-type": CONTENT_TYPE_PBLITE } }));
    if (!res.isErr() || res.error._tag !== "GMRequestError") throw new Error("expected GMRequestError");
    expect(res.error).toMatchObject({ status: 404, action: "testing", errorType: "5", googleMessage: "Requested entity was not found." });
  });

  test("non-2xx without a decodable message is a GMHttpError", async () => {
    const res = await request(respond("oops", { status: 503, headers: { "content-type": "text/html" } }));
    if (!res.isErr() || res.error._tag !== "GMHttpError") throw new Error("expected GMHttpError");
    expect(res.error.status).toBe(503);
    expect(res.error.message).toContain("try again shortly");
  });

  test("a network failure is a GMNetworkError", async () => {
    const res = await request(async () => {
      throw new TypeError("fetch failed");
    });
    expect(res.isErr() && res.error._tag === "GMNetworkError" && res.error.reason).toBe("network");
  });
});

describe("GMHttp.post timeouts and aborts", () => {
  const hanging: FetchFn = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });

  test("the per-request timeout aborts the fetch", async () => {
    const res = await GMHttp.post(ctxWith(hanging, null).ctx, { url: "https://x", action: "t", contentType: CONTENT_TYPE_PBLITE, body: "[]", timeoutMs: 20 });
    expect(res.isErr() && res.error._tag === "GMNetworkError" && res.error.reason).toBe("timeout");
  });

  test("the caller's signal gives GMAbortedError", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const res = await GMHttp.post(ctxWith(hanging, null).ctx, { url: "https://x", action: "t", contentType: CONTENT_TYPE_PBLITE, body: "[]", signal: controller.signal });
    expect(res.isErr() && res.error._tag).toBe("GMAbortedError");
  });
});

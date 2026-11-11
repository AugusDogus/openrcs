import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { verification } from "@/lib/db/auth-schema";
import { UPLOAD_MEDIA_URL } from "@/lib/gm/constants";
import { AesGcmHelper } from "@/lib/gm/crypto/aes-gcm";
import type { FetchFn } from "@/lib/gm/http";
import { MEDIA_LINK_TTL_MS, MediaLink, type MediaLinkConfig } from "./media-link";
import type { MediaGrant } from "./media";
import { RcsTesting, type RcsTestEnv } from "./testing";

const key = new Uint8Array(32).fill(3);
const grant: MediaGrant = {
  mediaId: "media-1",
  key,
  credentials: { tachyonAuthToken: new Uint8Array([9, 8, 7, 6]), network: "GDitto" },
};
const file = new TextEncoder().encode("<script>alert(1)</script>");

describe("MediaLink", () => {
  let env: RcsTestEnv;
  let config: MediaLinkConfig;
  const clock = RcsTesting.clock();

  beforeEach(async () => {
    env = await RcsTesting.setup();
    config = { db: env.db, origin: "https://openrcs.test", pepper: new Uint8Array(32).fill(1), now: clock.now };
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const tokenOf = (url: string): string => url.slice("https://openrcs.test/api/media/".length);
  const google: FetchFn = async (input) =>
    String(input) === UPLOAD_MEDIA_URL
      ? new Response(new Uint8Array(AesGcmHelper.encrypt(key, file).unwrap()))
      : new Response("unexpected", { status: 500 });

  test("a link opens to the grant it was created for until it expires", async () => {
    const link = (await MediaLink.create(config, { mimeType: "video/mp4", name: "clip.mp4" }, grant)).unwrap();
    expect(link.url).toMatch(/^https:\/\/openrcs\.test\/api\/media\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt.getTime()).toBe(clock.now() + MEDIA_LINK_TTL_MS);

    const target = (await MediaLink.open(config, tokenOf(link.url))).unwrap();
    expect(target.mimeType).toBe("video/mp4");
    expect(target.name).toBe("clip.mp4");
    expect(target.grant.mediaId).toBe("media-1");
    expect([...target.grant.key]).toEqual([...key]);
    expect([...target.grant.credentials.tachyonAuthToken]).toEqual([9, 8, 7, 6]);

    clock.advance(MEDIA_LINK_TTL_MS);
    const expired = await MediaLink.open(config, tokenOf(link.url));
    expect(expired.isErr() && expired.error).toMatchObject({ _tag: "MediaLinkInvalidError", reason: "expired" });
  });

  test("the stored row holds no key or token in the clear and needs the link's secret and the pepper", async () => {
    const link = (await MediaLink.create(config, { mimeType: "image/heic", name: "a.heic" }, grant)).unwrap();
    const token = tokenOf(link.url);
    const [id, secret] = token.split(".");
    const [row] = await env.db.select().from(verification).where(eq(verification.id, `media-link:${id}`));
    expect(row?.value.startsWith("m1.")).toBe(true);
    for (const secretText of [Buffer.from(key).toString("base64"), "media-1", "CQgHBg", secret ?? "?"]) {
      expect(row?.value).not.toContain(secretText);
    }

    const otherSecret = `${id}.${Buffer.alloc(32, 5).toString("base64url")}`;
    const wrong = await MediaLink.open(config, otherSecret);
    expect(wrong.isErr() && wrong.error).toMatchObject({ reason: "unreadable" });
    const otherPepper = await MediaLink.open({ ...config, pepper: new Uint8Array(32).fill(2) }, token);
    expect(otherPepper.isErr() && otherPepper.error).toMatchObject({ reason: "unreadable" });
  });

  test("malformed and unknown links are rejected", async () => {
    for (const token of ["", "abc", "a.b.c", `${"A".repeat(22)}.short`]) {
      const result = await MediaLink.open(config, token);
      expect(result.isErr() && result.error).toMatchObject({ reason: "malformed" });
    }
    const unknown = await MediaLink.open(config, `${Buffer.alloc(16, 1).toString("base64url")}.${Buffer.alloc(32, 1).toString("base64url")}`);
    expect(unknown.isErr() && unknown.error).toMatchObject({ reason: "unknown" });
  });

  test("creating a link drops expired ones", async () => {
    const old = (await MediaLink.create(config, { mimeType: "a/b", name: "old" }, grant)).unwrap();
    clock.advance(MEDIA_LINK_TTL_MS + 1);
    (await MediaLink.create(config, { mimeType: "a/b", name: "new" }, grant)).unwrap();
    const [id] = tokenOf(old.url).split(".");
    expect(await env.db.select().from(verification).where(eq(verification.id, `media-link:${id}`))).toHaveLength(0);
  });

  test("respond streams the decrypted file as a download that a browser will not render", async () => {
    const link = (await MediaLink.create(config, { mimeType: "text/html", name: 'evil"\r\n.html' }, grant)).unwrap();
    const response = await MediaLink.respond(config, tokenOf(link.url), { fetch: google });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<script>alert(1)</script>");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''evil%22__.html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("respond answers 404 for a bad link and 502 when Google refuses", async () => {
    expect((await MediaLink.respond(config, "nope", { fetch: google })).status).toBe(404);
    const link = (await MediaLink.create(config, { mimeType: "image/png", name: "a.png" }, grant)).unwrap();
    const refused = await MediaLink.respond(config, tokenOf(link.url), { fetch: async () => new Response("no", { status: 401 }) });
    expect(refused.status).toBe(502);
    expect(await refused.text()).not.toContain("media-1");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { migrate } from "drizzle-orm/libsql/migrator";
import { z } from "zod";
import { user } from "@/lib/db/auth-schema";
import { getDb } from "@/lib/db/client";
import type { McpScope } from "@/lib/oauth/scopes";
import { Store } from "@/lib/rcs/store";
import { RcsTesting } from "@/lib/rcs/testing";
import { Dek } from "@/lib/vault/dek";
import { ServerKey } from "@/lib/vault/server-key";
import { GMMessage } from "@/lib/gm/message";
import { createRcsMcpServer, type RcsMcpContext } from "./server";

// Tools resolve the app database with getDb(); point it at a temp file before
// the first call (never at the developer's .env.local database).
const dbPath = join(tmpdir(), `openrcs-mcp-test-${randomBytes(8).toString("hex")}.db`);
process.env.DATABASE_URL = `file:${dbPath}`;
// Tools unlock data with the server key, which needs the vault environment.
process.env.KEY_PEPPER = randomBytes(32).toString("base64");
process.env.BETTER_AUTH_URL ??= "https://openrcs.test";
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("base64");

const userId = `user_${randomBytes(6).toString("hex")}`;
let dek: Dek;

beforeAll(async () => {
  const db = getDb();
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  await db.insert(user).values({ id: userId, name: "Tool Tester", email: `${userId}@example.test` });
  dek = (await ServerKey.create(db, userId)).unwrap();
});

afterAll(async () => {
  getDb().$client.close();
  await Promise.all(["", "-wal", "-shm", "-journal"].map((s) => rm(`${dbPath}${s}`, { force: true })));
});

const auth = (scopes: readonly McpScope[], forUser = userId) => ({
  userId: forUser,
  grantId: "grant-1",
  clientId: "client-1",
  scopes,
});

const ResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string() })),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Call a tool over the real HTTP handler. Without `authInfo`, only the in-tool scope check applies. */
const callTool = async (
  scopes: readonly McpScope[],
  name: string,
  args: Record<string, unknown>,
  opts: { authInfo?: AuthInfo; userId?: string; testing?: RcsMcpContext["testing"] } = {},
) => {
  const handler = createMcpHandler(() => createRcsMcpServer({ auth: auth(scopes, opts.userId), testing: opts.testing }));
  const response = await handler.fetch(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    opts.authInfo === undefined ? undefined : { authInfo: opts.authInfo },
  );
  return response;
};

const toolResult = async (response: Response) => {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return ResultSchema.parse(JSON.parse(data === undefined ? text : data.slice(6))).result;
};

describe("scope enforcement", () => {
  test("send_message without messages:send is an isError naming the scope", async () => {
    const result = await toolResult(
      await callTool(["messages:read"], "send_message", { conversation_id: "c1", text: "hi" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"messages:send"');
    expect(result.content[0]?.text).toContain("Re-authorize");
  });

  for (const [name, args] of [
    ["list_conversations", {}],
    ["get_messages", { conversation_id: "c1" }],
    ["get_media", { message_id: "m1" }],
    ["search_messages", { query: "x" }],
    ["list_contacts", {}],
    ["sync_messages", {}],
  ] as const) {
    test(`${name} without messages:read is an isError naming the scope`, async () => {
      const result = await toolResult(await callTool(["messages:send"], name, args));
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('"messages:read"');
    });
  }

  test("the HTTP layer answers 403 insufficient_scope when authInfo lacks the scope", async () => {
    const response = await callTool(["messages:read"], "send_message", { conversation_id: "c1", text: "hi" }, {
      authInfo: {
        token: "test",
        clientId: "client-1",
        scopes: ["messages:read"],
        resource: new URL("http://localhost/api/mcp"),
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="messages:send"');
  });
});

describe("pairing gates", () => {
  test("read tools report an unpaired phone as an error with the next step", async () => {
    const result = await toolResult(await callTool(["messages:read"], "list_conversations", { refresh: false }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No phone is paired");
  });

  test("get_status works unpaired and reports counts", async () => {
    const result = await toolResult(await callTool(["messages:read"], "get_status", {}));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.pairing).toMatchObject({ status: "unpaired" });
    expect(result.structuredContent?.stored).toEqual({ conversations: 0, messages: 0 });
  });

  test("once paired, cached data is served, unlocked with the server key", async () => {
    const db = getDb();
    const ctx = { userId, dek };
    await RcsTesting.pair(db, ctx);
    await Store.upsertConversations(db, ctx, [
      {
        conversationId: "c1",
        name: "Alice",
        isGroup: false,
        participants: [],
        lastMessageTimestampMs: Date.UTC(2026, 10, 5),
        lastMessagePreview: "hello",
        unread: false,
        readOnly: false,
        status: "ACTIVE",
      },
    ]);
    const listed = await toolResult(await callTool(["messages:read"], "list_conversations", { refresh: false }));
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]?.text).toContain("Alice [c1]");
    expect(listed.structuredContent?.conversations).toEqual([
      {
        conversation_id: "c1",
        name: "Alice",
        is_group: false,
        participants: [],
        last_message_at: "2026-11-05T00:00:00.000Z",
        last_message_preview: "hello",
        unread: false,
      },
    ]);

  });

  test("a session without a server key is not paired", async () => {
    const db = getDb();
    const other = `user_${randomBytes(6).toString("hex")}`;
    await db.insert(user).values({ id: other, name: "No Key", email: `${other}@example.test` });
    await RcsTesting.pair(db, { userId: other, dek: Dek.generate() });
    const result = await toolResult(
      await callTool(["messages:read"], "list_conversations", { refresh: false }, { userId: other }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No phone is paired");
  });

  test("send_message validates the target before touching the phone", async () => {
    const result = await toolResult(
      await callTool(["messages:send"], "send_message", { conversation_id: "c1", phone_number: "+15551234567", text: "hi" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exactly one of conversation_id");
  });
});

describe("get_media", () => {
  const key = new Uint8Array(32).fill(4);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
  const MediaResultSchema = z.object({
    result: z.object({
      isError: z.boolean().optional(),
      content: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
        ]),
      ),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    }),
  });
  const mediaResult = async (response: Response) => {
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return MediaResultSchema.parse(JSON.parse(data === undefined ? text : data.slice(6))).result;
  };
  const attachment = (id: string, mimeType: string, name: string) =>
    GMMessage.toPlain(
      RcsTesting.message({
        id,
        conversationId: "c1",
        timestampMs: Date.UTC(2026, 10, 6),
        text: "",
        media: { id: `media-${id}`, key, mimeType, name, size: png.length },
      }),
    );
  const phone = RcsTesting.fakePhone({ media: new Map([["media-shot", { key, data: png }]]) });
  const testing = (): RcsMcpContext["testing"] => ({
    phone: { createClient: RcsTesting.fakeClient(phone) },
    mediaLink: { db: getDb(), origin: "https://openrcs.test", pepper: new Uint8Array(32).fill(8), now: Date.now },
  });

  beforeAll(async () => {
    const ctx = { userId, dek };
    await RcsTesting.pair(getDb(), ctx);
    (await Store.upsertMessages(getDb(), ctx, [
      attachment("shot", "image/png", "IMG_2375.png"),
      attachment("clip", "video/mp4", "clip.mp4"),
    ])).unwrap();
  });

  test("an image comes back as an MCP image content block", async () => {
    const result = await mediaResult(
      await callTool(["messages:read"], "get_media", { message_id: "shot" }, { testing: testing() }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "IMG_2375.png (image/png, 12 bytes) from message shot." },
      { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
    ]);
    expect(result.structuredContent).toEqual({
      message_id: "shot",
      conversation_id: "c1",
      media_id: "media-shot",
      mime_type: "image/png",
      name: "IMG_2375.png",
      size: 12,
      preview: false,
      delivery: "image",
      download_url: null,
      download_expires_at: null,
    });
  });

  test("other attachments, and images on request, come back as a short-lived download link", async () => {
    for (const args of [{ message_id: "clip" }, { message_id: "shot", as_link: true }]) {
      const result = await mediaResult(await callTool(["messages:read"], "get_media", args, { testing: testing() }));
      expect(result.isError).toBeUndefined();
      expect(result.content.map((c) => c.type)).toEqual(["text"]);
      expect(result.structuredContent).toMatchObject({ message_id: args.message_id, delivery: "link" });
      const url = z.string().parse(result.structuredContent?.download_url);
      expect(url).toMatch(/^https:\/\/openrcs\.test\/api\/media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const expires = Date.parse(z.string().parse(result.structuredContent?.download_expires_at));
      expect(expires - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(expires - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    }
  });

  test("get_messages never exposes the attachment key", async () => {
    const result = await toolResult(
      await callTool(["messages:read"], "get_messages", { conversation_id: "c1", refresh: false }),
    );
    expect(JSON.stringify(result)).not.toContain(Buffer.from(key).toString("base64"));
    expect(result.structuredContent?.messages).toContainEqual(
      expect.objectContaining({
        message_id: "shot",
        media: { media_id: "media-shot", mime_type: "image/png", name: "IMG_2375.png", size: 12 },
      }),
    );
  });

  test("a message without an attachment is an error that says so", async () => {
    const result = await mediaResult(
      await callTool(["messages:read"], "get_media", { message_id: "missing" }, { testing: testing() }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("No stored message") });
  });
});

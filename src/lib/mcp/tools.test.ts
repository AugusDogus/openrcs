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
import { createRcsMcpServer } from "./server";

// Tools resolve the app database with getDb(); point it at a temp file before
// the first call (never at the developer's .env.local database).
const dbPath = join(tmpdir(), `openrcs-mcp-test-${randomBytes(8).toString("hex")}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

const userId = `user_${randomBytes(6).toString("hex")}`;
const dek = Dek.generate();

beforeAll(async () => {
  const db = getDb();
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  await db.insert(user).values({ id: userId, name: "Tool Tester", email: `${userId}@example.test` });
});

afterAll(async () => {
  getDb().$client.close();
  await Promise.all(["", "-wal", "-shm", "-journal"].map((s) => rm(`${dbPath}${s}`, { force: true })));
});

const auth = (scopes: readonly McpScope[], key = dek) => ({
  userId,
  grantId: "grant-1",
  clientId: "client-1",
  scopes,
  dek: key,
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
  opts: { authInfo?: AuthInfo; key?: Dek } = {},
) => {
  const handler = createMcpHandler(() => createRcsMcpServer({ auth: auth(scopes, opts.key) }));
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

  test("once paired, cached data is served; a stale key is refused", async () => {
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

    const stale = await toolResult(
      await callTool(["messages:read"], "list_conversations", { refresh: false }, { key: Dek.generate() }),
    );
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toContain("Re-authorize");
  });

  test("send_message validates the target before touching the phone", async () => {
    const result = await toolResult(
      await callTool(["messages:send"], "send_message", { conversation_id: "c1", phone_number: "+15551234567", text: "hi" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exactly one of conversation_id");
  });
});

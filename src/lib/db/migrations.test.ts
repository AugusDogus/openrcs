import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { z } from "zod";
import { createDatabase, type Database } from "@/lib/db/client";
import { KeySlot, SlotCredential } from "@/lib/vault/key-slot";
import { VaultTesting } from "@/lib/vault/testing";

/**
 * Upgrading a database from the client-held-key vault (migrations up to 0004)
 * keeps OAuth clients connected and drops what only clients could decrypt.
 */

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const LAST_SPLIT_KEY_MIGRATION = "0004_split_key_vault";

const JournalSchema = z.object({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(z.object({ idx: z.number(), tag: z.string() }).loose()),
});

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openrcs-migrations-"));
  db = createDatabase({ url: `file:${join(dir, "test.db")}` });
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** A copy of the migrations folder that stops at `lastTag`. */
const migrationsUpTo = async (lastTag: string): Promise<string> => {
  const folder = join(dir, "drizzle-old");
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(last).toBeGreaterThanOrEqual(0);
  await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }));
  return folder;
};

const count = async (table: string) => {
  const result = await db.$client.execute(`select count(*) as n from ${table}`);
  return Number(result.rows[0]?.n);
};

describe("upgrade from the client-held-key vault", () => {
  test("refresh tokens and grants survive; device slots and unreadable data are removed", async () => {
    await migrate(db, { migrationsFolder: await migrationsUpTo(LAST_SPLIT_KEY_MIGRATION) });
    const userId = await VaultTesting.createUser(db);
    const vault = VaultTesting.vaultConfig();
    const refresh = SlotCredential.generate();
    const device = SlotCredential.generate();
    const now = Date.now();
    const exec = (sql: string, args: (string | number | null)[]) => db.$client.execute({ sql, args });

    await exec(
      "insert into oauth_client (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, scope) values (?, ?, ?, ?, ?)",
      ["executor", "Executor", "[]", "none", "messages:read messages:send"],
    );
    await exec("insert into oauth_grant (id, user_id, client_id, scope, dek_id) values (?, ?, ?, ?, ?)", [
      "grant-1",
      userId,
      "executor",
      "messages:read messages:send",
      "old-dek",
    ]);
    const insertSlot =
      "insert into key_slot (id, user_id, kind, dek_id, verifier, wrapped_dek, grant_id, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)";
    await exec(insertSlot, [
      refresh.slotId,
      userId,
      "oauth_refresh",
      "old-dek",
      KeySlot.verifierFor(vault.pepper, refresh),
      "k1.wrapped.dek",
      "grant-1",
      now + 60_000,
    ]);
    await exec(insertSlot, [device.slotId, userId, "device", "old-dek", "verifier", "k1.wrapped.dek", null, null]);
    await exec("insert into gm_session (user_id, kind, status, dek_id, auth_data_enc) values (?, ?, ?, ?, ?)", [
      userId,
      "gaia",
      "paired",
      "old-dek",
      "d1.sealed.session",
    ]);
    await exec(
      "insert into conversation (user_id, conversation_id, content_enc, is_group, last_message_ts, unread, read_only, status) values (?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, "c1", "d1.sealed.conversation", 0, now, 0, 0, "ACTIVE"],
    );
    await exec(
      "insert into message (user_id, message_id, conversation_id, from_me, content_enc, timestamp, status) values (?, ?, ?, ?, ?, ?, ?)",
      [userId, "m1", "c1", 0, "d1.sealed.message", now, "ok"],
    );
    await exec("insert into sync_state (user_id, last_sync_at) values (?, ?)", [userId, now]);

    await migrate(db, { migrationsFolder });

    const opened = await KeySlot.open(db, vault, { credential: refresh, kind: "oauth_refresh", userId });
    expect(opened.isOk() && opened.value.grantId).toBe("grant-1");
    const grant = await db.$client.execute("select revoked_at from oauth_grant where id = 'grant-1'");
    expect(grant.rows).toHaveLength(1);
    expect(grant.rows[0]?.revoked_at).toBeNull();

    expect(await count("key_slot where kind = 'device'")).toBe(0);
    for (const table of ["gm_session", "conversation", "message", "sync_state", "user_key"]) {
      expect(await count(table)).toBe(0);
    }
    const columns = await db.$client.execute("select name from pragma_table_info('key_slot')");
    expect(columns.rows.map((row) => row.name)).not.toContain("wrapped_dek");
    await expect(
      exec("insert into key_slot (id, user_id, kind, verifier) values (?, ?, ?, ?)", [
        randomBytes(8).toString("hex"),
        userId,
        "device",
        "v",
      ]),
    ).rejects.toThrow();
  });
});

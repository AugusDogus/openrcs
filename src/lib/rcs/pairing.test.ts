import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthData } from "@/lib/gm/auth-data";
import { Dek } from "@/lib/vault/dek";
import { ServerKey } from "@/lib/vault/server-key";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { savePairing } from "./pairing";
import { SessionStore } from "./session-store";
import { Store } from "./store";
import { RcsTesting } from "./testing";

let t: TestDatabase;
let userId: string;
const vault = VaultTesting.vaultConfig();

beforeEach(async () => {
  t = await VaultTesting.createDb();
  userId = await VaultTesting.createUser(t.db);
});
afterEach(async () => {
  await t.cleanup();
});

const paired = () => ({ authData: AuthData.createForPairing(), phoneId: "source-id/1234567" });

const storeConversation = async (ctx: { userId: string; dek: Dek }) => {
  (
    await Store.upsertConversations(t.db, ctx, [
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
    ])
  ).unwrap();
};

describe("savePairing", () => {
  test("the first pairing creates the server key and saves the session under it", async () => {
    const ctx = (await savePairing(t.db, { userId, paired: paired(), vault })).unwrap();
    const key = (await ServerKey.unlockWith(t.db, vault, userId)).unwrap();
    expect(key?.id).toBe(ctx.dek.id);
    const session = (await SessionStore.load(t.db, ctx)).unwrap();
    expect(session).toMatchObject({ status: "paired", dekId: ctx.dek.id, phoneLabel: "Android phone (234567)" });
  });

  test("re-pairing (from any browser) keeps the key and the stored messages", async () => {
    const first = (await savePairing(t.db, { userId, paired: paired(), vault })).unwrap();
    await storeConversation(first);
    (await SessionStore.record(t.db, userId, { type: "authExpired", error: "signed out" })).unwrap();

    const again = (await savePairing(t.db, { userId, paired: paired(), vault })).unwrap();
    expect(again.dek.id).toBe(first.dek.id);
    expect((await Store.counts(t.db, userId)).unwrap()).toEqual({ conversations: 1, messages: 0 });
    expect((await SessionStore.load(t.db, again)).unwrap().status).toBe("paired");
    const listed = (await Store.listConversations(t.db, again, { limit: 10 })).unwrap();
    expect(listed.conversations.map((c) => c.name)).toEqual(["Alice"]);
    expect(listed.unreadable).toBe(0);
  });

  test("without a server key, rows sealed under another key are deleted and replaced", async () => {
    const old = { userId, dek: Dek.generate() };
    await RcsTesting.pair(t.db, old);
    await storeConversation(old);

    const ctx = (await savePairing(t.db, { userId, paired: paired(), vault })).unwrap();
    expect(ctx.dek.id).not.toBe(old.dek.id);
    expect((await Store.counts(t.db, userId)).unwrap()).toEqual({ conversations: 0, messages: 0 });
    expect((await SessionStore.load(t.db, ctx)).isOk()).toBe(true);
  });

  test("a server key that no longer opens (another KEY_PEPPER) is replaced, with the data it sealed", async () => {
    const first = (await savePairing(t.db, { userId, paired: paired(), vault: VaultTesting.vaultConfig() })).unwrap();
    await storeConversation(first);
    const ctx = (await savePairing(t.db, { userId, paired: paired(), vault })).unwrap();
    expect(ctx.dek.id).not.toBe(first.dek.id);
    expect((await Store.counts(t.db, userId)).unwrap().conversations).toBe(0);
    expect((await ServerKey.unlockWith(t.db, vault, userId)).unwrap()?.id).toBe(ctx.dek.id);
  });
});

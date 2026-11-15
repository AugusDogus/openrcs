import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { userKey } from "@/lib/db/vault-schema";
import { ServerKey } from "./server-key";
import { VaultTesting, type TestDatabase } from "./testing";

let t: TestDatabase;
let userId: string;
const config = VaultTesting.vaultConfig();

beforeEach(async () => {
  t = await VaultTesting.createDb();
  userId = await VaultTesting.createUser(t.db);
});
afterEach(async () => {
  await t.cleanup();
});

const storedRow = async (id: string) => {
  const [row] = await t.db.select().from(userKey).where(eq(userKey.userId, id));
  if (!row) throw new Error("expected a user_key row");
  return row;
};

describe("ServerKey", () => {
  test("no key until one is created; then it unlocks to the same DEK", async () => {
    expect((await ServerKey.unlockWith(t.db, config, userId)).unwrap()).toBeNull();
    const dek = (await ServerKey.createWith(t.db, config, userId)).unwrap();
    const unlocked = (await ServerKey.unlockWith(t.db, config, userId)).unwrap();
    expect(unlocked?.id).toBe(dek.id);
    expect(unlocked && Buffer.from(unlocked.bytes).equals(Buffer.from(dek.bytes))).toBe(true);
  });

  test("stores only the wrapped DEK, in a versioned envelope", async () => {
    const dek = (await ServerKey.createWith(t.db, config, userId)).unwrap();
    const row = await storedRow(userId);
    expect(row.dekId).toBe(dek.id);
    expect(row.wrappedDek.startsWith("s1.")).toBe(true);
    expect(row.wrappedDek).not.toContain(Buffer.from(dek.bytes).toString("base64url"));
  });

  test("creating again replaces the key", async () => {
    const first = (await ServerKey.createWith(t.db, config, userId)).unwrap();
    const second = (await ServerKey.createWith(t.db, config, userId)).unwrap();
    expect(second.id).not.toBe(first.id);
    expect((await ServerKey.unlockWith(t.db, config, userId)).unwrap()?.id).toBe(second.id);
  });

  test("a row moved to another user, or relabelled with another dek id, does not open", async () => {
    await ServerKey.createWith(t.db, config, userId);
    const row = await storedRow(userId);
    const otherUser = await VaultTesting.createUser(t.db);
    for (const moved of [
      { ...row, userId: otherUser },
      { ...row, dekId: "another-dek-id" },
    ]) {
      const result = ServerKey.unwrap(config, moved);
      expect(result.isErr() && result.error._tag).toBe("ServerKeyInvalidError");
    }
    await t.db.insert(userKey).values({ ...row, userId: otherUser });
    const unlocked = await ServerKey.unlockWith(t.db, config, otherUser);
    expect(unlocked.isErr() && unlocked.error._tag).toBe("ServerKeyInvalidError");
  });

  test("another KEY_PEPPER cannot open it", async () => {
    await ServerKey.createWith(t.db, config, userId);
    const result = await ServerKey.unlockWith(t.db, VaultTesting.vaultConfig(), userId);
    expect(result.isErr() && result.error._tag).toBe("ServerKeyInvalidError");
  });

  test("delete removes only that user's key", async () => {
    const otherUser = await VaultTesting.createUser(t.db);
    await ServerKey.createWith(t.db, config, userId);
    await ServerKey.createWith(t.db, config, otherUser);
    (await ServerKey.delete(t.db, userId)).unwrap();
    expect((await ServerKey.unlockWith(t.db, config, userId)).unwrap()).toBeNull();
    expect((await ServerKey.unlockWith(t.db, config, otherUser)).unwrap()).not.toBeNull();
  });
});

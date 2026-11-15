import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { keySlot } from "@/lib/db/vault-schema";
import { Dek } from "./dek";
import type { KeySlotConsumedError, KeySlotInvalidError, VaultStorageError } from "./errors";
import { KeySlot, SlotCredential } from "./key-slot";
import { VaultTesting, type TestDatabase } from "./testing";

let t: TestDatabase;
let userId: string;
const clock = VaultTesting.clock();
const config = VaultTesting.vaultConfig({ now: clock.now });

beforeEach(async () => {
  t = await VaultTesting.createDb();
  userId = await VaultTesting.createUser(t.db);
});
afterEach(async () => {
  await t.cleanup();
});

const mintAndStore = async (
  kind: "device" | "oauth_refresh" = "device",
  expiresAt: number | null = clock.now() + 60_000,
  dek = Dek.generate(),
) => {
  const minted = KeySlot.mint(config, { userId, kind, dek, expiresAt });
  await t.db.insert(keySlot).values(minted.values);
  return { ...minted, dek };
};

type OpenResult = Awaited<ReturnType<typeof KeySlot.open>>;
type KeySlotOpenError = KeySlotInvalidError | KeySlotConsumedError | VaultStorageError;

const expectRejected = async (
  result: OpenResult,
  tag: KeySlotOpenError["_tag"],
  reason?: KeySlotInvalidError["reason"],
) => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error._tag).toBe(tag);
    if (reason !== undefined && result.error._tag === "KeySlotInvalidError") {
      expect(result.error.reason).toBe(reason);
    }
  }
};

describe("SlotCredential", () => {
  test("format / parse round-trip and reject anything non-canonical", () => {
    const credential = SlotCredential.generate();
    const formatted = SlotCredential.format("ort_", credential);
    expect(SlotCredential.parse("ort_", formatted)).toEqual(credential);
    expect(SlotCredential.parse("oac_", formatted)).toBeUndefined();
    expect(SlotCredential.parse("ort_", `${formatted}A`)).toBeUndefined();
    expect(SlotCredential.parse("ort_", `${formatted}.x`)).toBeUndefined();
    expect(SlotCredential.parse("ort_", "ort_short.secret")).toBeUndefined();
    const shortSecret = SlotCredential.format("ort_", {
      slotId: credential.slotId,
      secret: new Uint8Array(randomBytes(16)),
    });
    expect(SlotCredential.parse("ort_", shortSecret)).toBeUndefined();
  });
});

describe("KeySlot", () => {
  test("stores only a verifier and a wrapped DEK, never the secret or DEK", async () => {
    const { values, credential, dek } = await mintAndStore();
    const stored = JSON.stringify(values);
    expect(stored).not.toContain(Buffer.from(credential.secret).toString("base64url"));
    expect(stored).not.toContain(Buffer.from(dek.bytes).toString("base64url"));
    expect(values.wrappedDek.startsWith("k1.")).toBe(true);
  });

  test("opens with the right secret and returns the DEK", async () => {
    const { credential, dek } = await mintAndStore();
    const opened = await KeySlot.open(t.db, config, { credential, kind: "device", userId });
    expect(opened.isOk()).toBe(true);
    if (opened.isOk()) {
      expect(opened.value.dek.id).toBe(dek.id);
      expect(Buffer.from(opened.value.dek.bytes).equals(Buffer.from(dek.bytes))).toBe(true);
    }
  });

  test("wrong secret is rejected", async () => {
    const { credential } = await mintAndStore();
    const wrong = { slotId: credential.slotId, secret: new Uint8Array(randomBytes(32)) };
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: wrong, kind: "device" }),
      "KeySlotInvalidError",
      "wrong_secret",
    );
  });

  test("wrong pepper is rejected even with the right secret", async () => {
    const { credential } = await mintAndStore();
    const otherPepper = VaultTesting.vaultConfig({ now: clock.now });
    await expectRejected(
      await KeySlot.open(t.db, otherPepper, { credential, kind: "device" }),
      "KeySlotInvalidError",
      "wrong_secret",
    );
  });

  test("unknown slot, wrong kind and wrong user are rejected", async () => {
    const { credential } = await mintAndStore();
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: SlotCredential.generate(), kind: "device" }),
      "KeySlotInvalidError",
      "not_found",
    );
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "wrong_kind",
    );
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "device", userId: "someone_else" }),
      "KeySlotInvalidError",
      "wrong_user",
    );
  });

  test("revoked slots are rejected", async () => {
    const { credential } = await mintAndStore();
    await t.db.update(keySlot).set({ revokedAt: clock.now() }).where(eq(keySlot.id, credential.slotId));
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "device" }),
      "KeySlotInvalidError",
      "revoked",
    );
  });

  test("expired slots are rejected at the expiry instant", async () => {
    const { credential } = await mintAndStore("device", clock.now() + 1_000);
    clock.advance(999);
    expect((await KeySlot.open(t.db, config, { credential, kind: "device" })).isOk()).toBe(true);
    clock.advance(1);
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "device" }),
      "KeySlotInvalidError",
      "expired",
    );
  });

  test("consumed slots report KeySlotConsumedError with the consumption time", async () => {
    const { credential } = await mintAndStore("oauth_refresh");
    const consumedAt = clock.now();
    await t.db.update(keySlot).set({ consumedAt }).where(eq(keySlot.id, credential.slotId));
    const result = await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" });
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "KeySlotConsumedError") {
      expect(result.error.consumedAt).toBe(consumedAt);
    } else {
      throw new Error("expected KeySlotConsumedError");
    }
  });

  test("a consumed slot whose key share was destroyed still reports KeySlotConsumedError", async () => {
    const { credential, values } = await mintAndStore("oauth_refresh", clock.now() + 1_000);
    await t.db.update(keySlot).set({ consumedAt: clock.now() }).where(eq(keySlot.id, credential.slotId));
    clock.advance(1_000);
    (await KeySlot.destroyExpired(t.db, userId, clock.now())).unwrap();
    const [row] = await t.db.select().from(keySlot).where(eq(keySlot.id, credential.slotId));
    expect(row?.wrappedDek).not.toBe(values.wrappedDek);
    const result = await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" });
    expect(result.isErr() && result.error._tag).toBe("KeySlotConsumedError");
  });

  test("an expired slot is tombstoned when it is presented", async () => {
    const { credential } = await mintAndStore("device", clock.now() + 1_000);
    clock.advance(1_000);
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "device" }),
      "KeySlotInvalidError",
      "expired",
    );
    const [row] = await t.db.select().from(keySlot).where(eq(keySlot.id, credential.slotId));
    expect(row?.wrappedDek).toBe(KeySlot.TOMBSTONE);
    expect(row && KeySlot.unwrap(config, row, credential).isErr()).toBe(true);
  });

  test("a wrapped DEK moved to another slot row does not unwrap", async () => {
    const a = await mintAndStore();
    const b = await mintAndStore();
    // Copy a's wrapped DEK into b's row: b's KEK and AAD differ, so it must fail.
    await t.db
      .update(keySlot)
      .set({ wrappedDek: a.values.wrappedDek })
      .where(eq(keySlot.id, b.credential.slotId));
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: b.credential, kind: "device" }),
      "KeySlotInvalidError",
      "unwrap_failed",
    );
  });
});

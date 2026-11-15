import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { keySlot, type KeySlotKind } from "@/lib/db/vault-schema";
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

const mintAndStore = async (kind: KeySlotKind = "oauth_refresh", expiresAt: number | null = clock.now() + 60_000) => {
  const minted = KeySlot.mint(config, { userId, kind, expiresAt });
  await t.db.insert(keySlot).values(minted.values);
  return minted;
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
  test("stores only a verifier, never the secret", async () => {
    const { values, credential } = await mintAndStore();
    expect(JSON.stringify(values)).not.toContain(Buffer.from(credential.secret).toString("base64url"));
    expect(values.verifier).toBe(KeySlot.verifierFor(config.pepper, credential));
  });

  test("opens with the right secret and returns the slot", async () => {
    const { credential } = await mintAndStore();
    const opened = await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh", userId });
    expect(opened.isOk() && opened.value.id).toBe(credential.slotId);
  });

  test("wrong secret is rejected", async () => {
    const { credential } = await mintAndStore();
    const wrong = { slotId: credential.slotId, secret: new Uint8Array(randomBytes(32)) };
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: wrong, kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "wrong_secret",
    );
  });

  test("wrong pepper is rejected even with the right secret", async () => {
    const { credential } = await mintAndStore();
    const otherPepper = VaultTesting.vaultConfig({ now: clock.now });
    await expectRejected(
      await KeySlot.open(t.db, otherPepper, { credential, kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "wrong_secret",
    );
  });

  test("unknown slot, wrong kind and wrong user are rejected", async () => {
    const { credential } = await mintAndStore();
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: SlotCredential.generate(), kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "not_found",
    );
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "oauth_code" }),
      "KeySlotInvalidError",
      "wrong_kind",
    );
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh", userId: "someone_else" }),
      "KeySlotInvalidError",
      "wrong_user",
    );
  });

  test("revoked slots are rejected", async () => {
    const { credential } = await mintAndStore();
    await t.db.update(keySlot).set({ revokedAt: clock.now() }).where(eq(keySlot.id, credential.slotId));
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "revoked",
    );
  });

  test("expired slots are rejected at the expiry instant", async () => {
    const { credential } = await mintAndStore("oauth_refresh", clock.now() + 1_000);
    clock.advance(999);
    expect((await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" })).isOk()).toBe(true);
    clock.advance(1);
    await expectRejected(
      await KeySlot.open(t.db, config, { credential, kind: "oauth_refresh" }),
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

  test("a verifier copied to another slot row does not verify", async () => {
    const a = await mintAndStore();
    const b = await mintAndStore();
    await t.db.update(keySlot).set({ verifier: a.values.verifier }).where(eq(keySlot.id, b.credential.slotId));
    await expectRejected(
      await KeySlot.open(t.db, config, { credential: b.credential, kind: "oauth_refresh" }),
      "KeySlotInvalidError",
      "wrong_secret",
    );
  });
});

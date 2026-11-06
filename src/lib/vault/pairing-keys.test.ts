import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keySlot, oauthClient, oauthGrant } from "@/lib/db/vault-schema";
import { Dek } from "./dek";
import { DeviceCookie, DeviceUnlock } from "./device";
import { KeySlot } from "./key-slot";
import { PairingKeys, type PreparedPairingKey } from "./pairing-keys";
import { VaultTesting, type TestDatabase } from "./testing";
import { Vault } from "./vault";

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

const noHooks = { onKeyRotated: async () => {} };

/** Prepares and commits a pairing, returning the Cookie header the browser now holds. */
const pairBrowser = async (cookieHeader: string | null, mode: "pairing" | "consent" = "pairing") => {
  const prepared = (await PairingKeys.prepareWith(t.db, config, userId, cookieHeader, { mode })).unwrap();
  (await PairingKeys.commitWith(t.db, config, prepared, noHooks)).unwrap();
  const cookie = prepared.setCookie ? VaultTesting.cookiePair(prepared.setCookie) : cookieHeader;
  return { prepared, cookie };
};

const insertGrant = async (dek: Dek, id = `grant_${dek.id}`) => {
  await t.db
    .insert(oauthClient)
    .values({
      clientId: `client_${id}`,
      clientName: "Test",
      redirectUrisJson: "[]",
      tokenEndpointAuthMethod: "none",
      scope: "messages:read",
    })
    .onConflictDoNothing();
  await t.db.insert(oauthGrant).values({
    id,
    userId,
    clientId: `client_${id}`,
    scope: "messages:read",
    dekId: dek.id,
  });
  return id;
};

describe("DeviceCookie", () => {
  const secureSettings = { name: "__Host-openrcs-device", secure: true };

  test("serializes per-user __Host- cookies with Secure over https and plain ones over http", () => {
    const prepared = KeySlot.mint(config, { userId, kind: "device", dek: Dek.generate(), expiresAt: null });
    const name = DeviceCookie.nameFor(secureSettings, userId);
    expect(name).toMatch(/^__Host-openrcs-device-[A-Za-z0-9_-]{16}$/);
    expect(name).not.toContain(userId);
    const secure = DeviceCookie.serialize(secureSettings, userId, prepared.credential);
    expect(secure).toMatch(
      /^__Host-openrcs-device-[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure$/,
    );
    const insecure = DeviceCookie.serialize({ name: "__openrcs-device", secure: false }, userId, prepared.credential);
    expect(insecure).not.toContain("Secure");
    expect(insecure.startsWith("__openrcs-device-")).toBe(true);
    expect(Vault.clearDeviceCookieWith(secureSettings, userId)).toBe(
      `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  test("reads this user's device cookie among others, falling back to the unscoped legacy cookie", () => {
    const mine = DeviceCookie.nameFor(secureSettings, userId);
    const theirs = DeviceCookie.nameFor(secureSettings, "someone_else");
    expect(mine).not.toBe(theirs);
    expect(DeviceCookie.read(secureSettings, userId, `a=1; ${theirs}=x.y; ${mine}=abc.def; b=2`)).toBe("abc.def");
    expect(DeviceCookie.read(secureSettings, userId, `${theirs}=x.y`)).toBeUndefined();
    expect(DeviceCookie.read(secureSettings, userId, "__Host-openrcs-device=old.key")).toBe("old.key");
    expect(DeviceCookie.read(secureSettings, userId, `__Host-openrcs-device=old.key; ${mine}=abc.def`)).toBe("abc.def");
    expect(DeviceCookie.read(secureSettings, userId, "__openrcs-device=abc.def")).toBeUndefined();
    expect(DeviceCookie.read(secureSettings, userId, null)).toBeUndefined();
  });
});

/** Merges Cookie headers the way a browser jar does: later values win per name. */
const mergeCookies = (...headers: readonly (string | null)[]): string => {
  const jar = new Map<string, string>();
  for (const header of headers) {
    for (const part of (header ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
};

describe("several accounts in one browser", () => {
  test("a second account's pairing or consent never replaces the first account's device key", async () => {
    const alice = await pairBrowser(null);
    await VaultTesting.pairSession(t.db, userId, alice.prepared.dek);
    const bob = await VaultTesting.createUser(t.db);

    for (const mode of ["pairing", "consent"] as const) {
      // Bob's prepare sets his cookie at stream start even if he then cancels (no commit).
      const prepared = (await PairingKeys.prepareWith(t.db, config, bob, alice.cookie, { mode })).unwrap();
      expect(prepared.isNewKey).toBe(true);
      const jar = mergeCookies(alice.cookie, prepared.setCookie ? VaultTesting.cookiePair(prepared.setCookie) : null);
      const unlocked = await DeviceUnlock.unlockWith(t.db, config, userId, jar);
      expect(unlocked.isOk() && unlocked.value.id).toBe(alice.prepared.dek.id);
      const consent = await PairingKeys.prepareWith(t.db, config, userId, jar, { mode: "consent" });
      expect(consent.isOk() && consent.value.isNewKey).toBe(false);
    }
  });
});

describe("DeviceUnlock", () => {
  test("locked without a cookie, with a malformed one, or for another user", async () => {
    const reasons = async (cookie: string | null, forUser = userId) => {
      const result = await DeviceUnlock.unlockWith(t.db, config, forUser, cookie);
      return result.isErr() && result.error._tag === "VaultLockedError" ? result.error.reason : "ok";
    };
    expect(await reasons(null)).toBe("no_cookie");
    expect(await reasons("__Host-openrcs-device=nope")).toBe("malformed_cookie");
    const { cookie } = await pairBrowser(null);
    expect(await reasons(cookie)).toBe("ok");
    const otherUser = await VaultTesting.createUser(t.db);
    // Another account looks for its own cookie name, so it does not even see this one...
    expect(await reasons(cookie, otherUser)).toBe("no_cookie");
    // ...and an unscoped legacy cookie only unlocks the account it belongs to.
    const legacy = `__Host-openrcs-device=${(cookie ?? "").split("=")[1] ?? ""}`;
    expect(await reasons(legacy)).toBe("ok");
    expect(await reasons(legacy, otherUser)).toBe("wrong_user");
  });
});

describe("PairingKeys mode pairing", () => {
  test("first pairing mints a DEK and a device slot; the same browser reuses it", async () => {
    const first = await pairBrowser(null);
    expect(first.prepared.isNewKey).toBe(true);
    expect(first.prepared.setCookie).toContain(`${DeviceCookie.nameFor(config.deviceCookie, userId)}=`);
    await VaultTesting.pairSession(t.db, userId, first.prepared.dek);

    const again = await pairBrowser(first.cookie);
    expect(again.prepared.isNewKey).toBe(false);
    expect(again.prepared.setCookie).toBeNull();
    expect(again.prepared.dek.id).toBe(first.prepared.dek.id);
  });

  test("prepare alone persists nothing", async () => {
    const prepared = (await PairingKeys.prepareWith(t.db, config, userId, null, { mode: "pairing" })).unwrap();
    expect(prepared.isNewKey).toBe(true);
    const slots = await t.db.select().from(keySlot).where(eq(keySlot.userId, userId));
    expect(slots).toHaveLength(0);
  });

  test("re-pairing from another browser rotates the key: old slots and grants revoked, hook runs before the new slot is stored", async () => {
    const first = await pairBrowser(null);
    await VaultTesting.pairSession(t.db, userId, first.prepared.dek);
    const grantId = await insertGrant(first.prepared.dek);

    const prepared = (await PairingKeys.prepareWith(t.db, config, userId, null, { mode: "pairing" })).unwrap();
    expect(prepared.isNewKey).toBe(true);
    expect(prepared.dek.id).not.toBe(first.prepared.dek.id);

    const events: string[] = [];
    (
      await PairingKeys.commitWith(t.db, config, prepared, {
        onKeyRotated: async () => {
          const [grant] = await t.db.select().from(oauthGrant).where(eq(oauthGrant.id, grantId));
          const newSlots = await t.db
            .select()
            .from(keySlot)
            .where(eq(keySlot.dekId, prepared.dek.id));
          events.push(`grant revoked=${grant?.revokedAt !== null} newSlots=${newSlots.length}`);
        },
      })
    ).unwrap();
    expect(events).toEqual(["grant revoked=true newSlots=0"]);

    const [grant] = await t.db.select().from(oauthGrant).where(eq(oauthGrant.id, grantId));
    expect(grant?.revokedReason).toBe("key_rotated");
    const oldUnlock = await DeviceUnlock.unlockWith(t.db, config, userId, first.cookie);
    expect(oldUnlock.isErr()).toBe(true);
    if (prepared.isNewKey) {
      const newCookie = VaultTesting.cookiePair(prepared.setCookie);
      await VaultTesting.pairSession(t.db, userId, prepared.dek);
      expect((await DeviceUnlock.unlockWith(t.db, config, userId, newCookie)).isOk()).toBe(true);
    }
  });

  test("key rotation destroys the key share of every revoked slot", async () => {
    const first = await pairBrowser(null);
    await VaultTesting.pairSession(t.db, userId, first.prepared.dek);
    const prepared = (await PairingKeys.prepareWith(t.db, config, userId, null, { mode: "pairing" })).unwrap();
    (await PairingKeys.commitWith(t.db, config, prepared, noHooks)).unwrap();
    const old = await t.db.select().from(keySlot).where(eq(keySlot.dekId, first.prepared.dek.id));
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((slot) => slot.revokedAt !== null && slot.wrappedDek === KeySlot.TOMBSTONE)).toBe(true);
  });

  test("commit is a no-op when the key did not change", async () => {
    const first = await pairBrowser(null);
    const grantId = await insertGrant(first.prepared.dek);
    let hookCalls = 0;
    const prepared: PreparedPairingKey = (
      await PairingKeys.prepareWith(t.db, config, userId, first.cookie, { mode: "pairing" })
    ).unwrap();
    (
      await PairingKeys.commitWith(t.db, config, prepared, {
        onKeyRotated: async () => {
          hookCalls += 1;
        },
      })
    ).unwrap();
    expect(hookCalls).toBe(0);
    const [grant] = await t.db.select().from(oauthGrant).where(eq(oauthGrant.id, grantId));
    expect(grant?.revokedAt).toBeNull();
  });

  test("a failing onKeyRotated hook stops before the new device slot is stored", async () => {
    const prepared = (await PairingKeys.prepareWith(t.db, config, userId, null, { mode: "pairing" })).unwrap();
    const result = await PairingKeys.commitWith(t.db, config, prepared, {
      onKeyRotated: async () => {
        throw new Error("delete failed");
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.operation).toContain("onKeyRotated");
    const slots = await t.db.select().from(keySlot).where(eq(keySlot.userId, userId));
    expect(slots).toHaveLength(0);
  });
});

describe("PairingKeys mode consent", () => {
  test("before any pairing, consent mints the DEK and device slot that pairing later reuses", async () => {
    const consent = await pairBrowser(null, "consent");
    expect(consent.prepared.isNewKey).toBe(true);
    const pairing = await pairBrowser(consent.cookie, "pairing");
    expect(pairing.prepared.isNewKey).toBe(false);
    expect(pairing.prepared.dek.id).toBe(consent.prepared.dek.id);
  });

  test("with a paired session, a browser that cannot unlock it is refused instead of minting", async () => {
    const first = await pairBrowser(null);
    await VaultTesting.pairSession(t.db, userId, first.prepared.dek);

    const elsewhere = await PairingKeys.prepareWith(t.db, config, userId, null, { mode: "consent" });
    expect(elsewhere.isErr()).toBe(true);
    if (elsewhere.isErr()) {
      expect(elsewhere.error._tag).toBe("VaultLockedError");
      if (elsewhere.error._tag === "VaultLockedError") {
        expect(elsewhere.error.reason).toBe("paired_elsewhere");
      }
    }

    const paired = await PairingKeys.prepareWith(t.db, config, userId, first.cookie, { mode: "consent" });
    expect(paired.isOk()).toBe(true);
    if (paired.isOk()) expect(paired.value.isNewKey).toBe(false);
  });
});

describe("Vault.revokeAll", () => {
  test("deletes every slot and grant of the user only", async () => {
    const mine = await pairBrowser(null);
    await insertGrant(mine.prepared.dek);
    const otherUser = await VaultTesting.createUser(t.db);
    const otherSlot = KeySlot.mint(config, { userId: otherUser, kind: "device", dek: Dek.generate(), expiresAt: null });
    await t.db.insert(keySlot).values(otherSlot.values);

    (await Vault.revokeAll(t.db, userId)).unwrap();
    expect(await t.db.select().from(keySlot).where(eq(keySlot.userId, userId))).toHaveLength(0);
    expect(await t.db.select().from(oauthGrant).where(eq(oauthGrant.userId, userId))).toHaveLength(0);
    expect(await t.db.select().from(keySlot).where(eq(keySlot.userId, otherUser))).toHaveLength(1);
  });
});

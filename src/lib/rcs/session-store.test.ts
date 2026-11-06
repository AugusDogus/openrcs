import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { gmSession } from "@/lib/db/app-schema";
import { AuthData } from "@/lib/gm/auth-data";
import { Dek } from "@/lib/vault/dek";
import { SessionStore, type SessionSignal } from "./session-store";
import { RcsTesting, type RcsTestEnv } from "./testing";

let env: RcsTestEnv;

beforeEach(async () => {
  env = await RcsTesting.setup();
});

afterEach(async () => {
  await env.cleanup();
});

const gaiaAuthData = () => ({
  ...AuthData.createForPairing(),
  destRegId: "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  cookies: { SID: "sid-secret-value", HSID: "h", SSID: "s", APISID: "a", SAPISID: "sap-secret" },
});

describe("SessionStore", () => {
  test("seals AuthData under the DEK and loads it back", async () => {
    const authData = gaiaAuthData();
    const saved = await SessionStore.save(env.db, env.ctx, { kind: "gaia", phoneLabel: "Pixel", authData });
    expect(saved.isOk()).toBe(true);

    const [row] = await env.db.select().from(gmSession).where(eq(gmSession.userId, env.userId));
    expect(row?.dekId).toBe(env.ctx.dek.id);
    expect(row?.status).toBe("paired");
    expect(row?.authDataEnc.startsWith("d1.")).toBe(true);
    expect(row?.authDataEnc).not.toContain("sid-secret-value");
    expect(JSON.stringify(row)).not.toContain("sap-secret");

    const loaded = (await SessionStore.load(env.db, env.ctx)).unwrap();
    expect(loaded.kind).toBe("gaia");
    expect(loaded.phoneLabel).toBe("Pixel");
    expect(AuthData.serialize(loaded.authData)).toBe(AuthData.serialize(authData));
  });

  test("a different DEK is a key mismatch and decrypts nothing", async () => {
    await SessionStore.save(env.db, env.ctx, { kind: "qr", phoneLabel: null, authData: AuthData.createForPairing() });
    const stale = { userId: env.userId, dek: Dek.generate() };
    const loaded = await SessionStore.load(env.db, stale);
    expect(loaded.isErr() && loaded.error._tag).toBe("RcsKeyMismatchError");
    if (loaded.isErr() && loaded.error._tag === "RcsKeyMismatchError") {
      expect(loaded.error.sessionDekId).toBe(env.ctx.dek.id);
      expect(loaded.error.clientDekId).toBe(stale.dek.id);
    }
  });

  test("the right key id with the wrong key bytes is reported as unreadable, not parsed", async () => {
    await SessionStore.save(env.db, env.ctx, { kind: "qr", phoneLabel: null, authData: AuthData.createForPairing() });
    const forged = { userId: env.userId, dek: { id: env.ctx.dek.id, bytes: Dek.generate().bytes } };
    const loaded = await SessionStore.load(env.db, forged);
    expect(loaded.isErr() && loaded.error._tag).toBe("RcsSessionCorruptError");
  });

  test("a session sealed for another user does not open", async () => {
    await SessionStore.save(env.db, env.ctx, { kind: "qr", phoneLabel: null, authData: AuthData.createForPairing() });
    const other = await RcsTesting.createUser(env.db);
    const [row] = await env.db.select().from(gmSession).where(eq(gmSession.userId, env.userId));
    if (row === undefined) throw new Error("expected the session row");
    await env.db.insert(gmSession).values({ ...row, userId: other });
    const loaded = await SessionStore.load(env.db, { userId: other, dek: env.ctx.dek });
    expect(loaded.isErr() && loaded.error._tag).toBe("RcsSessionCorruptError");
  });

  test("no session is not paired", async () => {
    const loaded = await SessionStore.load(env.db, env.ctx);
    expect(loaded.isErr() && loaded.error._tag).toBe("RcsNotPairedError");
  });

  test("saveAuthData refuses to overwrite a session sealed under another key", async () => {
    await SessionStore.save(env.db, env.ctx, { kind: "qr", phoneLabel: null, authData: AuthData.createForPairing() });
    const [before] = await env.db.select().from(gmSession);
    const result = await SessionStore.saveAuthData(
      env.db,
      { userId: env.userId, dek: Dek.generate() },
      AuthData.createForPairing(),
    );
    expect(result.isErr() && result.error._tag).toBe("RcsNotPairedError");
    const [after] = await env.db.select().from(gmSession);
    expect(after?.authDataEnc).toBe(before?.authDataEnc);
  });

  test("status transitions", () => {
    const failure = (type: Exclude<SessionSignal["type"], "connected">): SessionSignal => ({ type, error: "x" });
    expect(SessionStore.nextStatus("paired", { type: "connected", error: null })).toBe("paired");
    expect(SessionStore.nextStatus("paired", failure("failed"))).toBe("paired");
    expect(SessionStore.nextStatus("paired", failure("authExpired"))).toBe("needs_repair");
    expect(SessionStore.nextStatus("paired", failure("listenFatal"))).toBe("needs_repair");
    expect(SessionStore.nextStatus("paired", failure("gaiaLoggedOut"))).toBe("needs_repair");
    expect(SessionStore.nextStatus("needs_repair", failure("failed"))).toBe("needs_repair");
    expect(SessionStore.nextStatus("paired", failure("unpaired"))).toBe("unpaired");
    expect(SessionStore.nextStatus("unpaired", { type: "connected", error: null })).toBe("unpaired");
  });

  test("record applies the transition and connection bookkeeping", async () => {
    await SessionStore.save(env.db, env.ctx, { kind: "qr", phoneLabel: null, authData: AuthData.createForPairing() });
    const at = new Date(Date.UTC(2026, 10, 6, 12));
    await SessionStore.record(env.db, env.userId, { type: "connected", error: "Your phone did not respond" }, at);
    let record = (await SessionStore.readRecord(env.db, env.userId)).unwrap();
    expect(record?.status).toBe("paired");
    expect(record?.lastConnectedAt?.getTime()).toBe(at.getTime());
    expect(record?.lastError).toBe("Your phone did not respond");

    await SessionStore.record(env.db, env.userId, { type: "authExpired", error: "signed out" });
    record = (await SessionStore.readRecord(env.db, env.userId)).unwrap();
    expect(record?.status).toBe("needs_repair");
    expect(record?.lastError).toBe("signed out");
    expect(record?.lastConnectedAt?.getTime()).toBe(at.getTime());
  });
});

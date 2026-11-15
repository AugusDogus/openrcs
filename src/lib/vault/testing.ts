/**
 * Test support for the vault and OAuth server: temp file databases migrated
 * with the real migrations, users, and a controllable vault config. Never
 * imported by app code.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDatabase, type Database } from "@/lib/db/client";
import { user } from "@/lib/db/auth-schema";
import { gmSession } from "@/lib/db/app-schema";
import type { VaultConfig } from "./config";
import type { Dek } from "./dek";

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");

export type TestDatabase = { readonly db: Database; readonly cleanup: () => Promise<void> };

/** A fresh file database with every migration applied. */
const createDb = async (): Promise<TestDatabase> => {
  const path = join(tmpdir(), `openrcs-test-${randomBytes(8).toString("hex")}.db`);
  const db = createDatabase({ url: `file:${path}` });
  await migrate(db, { migrationsFolder });
  return {
    db,
    cleanup: async () => {
      db.$client.close();
      await Promise.all(
        ["", "-wal", "-shm", "-journal"].map((suffix) => rm(`${path}${suffix}`, { force: true })),
      );
    },
  };
};

const createUser = async (db: Database, id = `user_${randomBytes(6).toString("hex")}`) => {
  await db.insert(user).values({ id, name: "Test User", email: `${id}@example.test` });
  return id;
};

/** Simulates a paired phone: a gm_session row for `dek` (contents are irrelevant here). */
const pairSession = async (db: Database, userId: string, dek: Dek) => {
  await db
    .insert(gmSession)
    .values({ userId, kind: "qr", status: "paired", dekId: dek.id, authDataEnc: "d1.test.test" })
    .onConflictDoUpdate({ target: gmSession.userId, set: { dekId: dek.id } });
};

export type TestClock = { now: () => number; advance: (ms: number) => void; set: (ms: number) => void };

const clock = (start = Date.UTC(2026, 10, 6, 12, 0, 0)): TestClock => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
};

const vaultConfig = (options: { pepper?: Uint8Array; now?: () => number } = {}): VaultConfig => ({
  pepper: options.pepper ?? new Uint8Array(randomBytes(32)),
  now: options.now ?? (() => Date.now()),
});

export const VaultTesting = {
  createDb,
  createUser,
  pairSession,
  clock,
  vaultConfig,
} as const;

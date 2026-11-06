import { headers } from "next/headers";
import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { SessionStore, type GmSessionRecord } from "@/lib/rcs/session-store";
import { SyncState } from "@/lib/rcs/sync-state";
import { DeviceUnlock, type Dek } from "@/lib/vault";

/**
 * What the dashboard can show for the signed-in user: the session metadata,
 * and whether this browser's device cookie unlocks it. The DEK stays on the
 * server; components only receive decrypted values they render.
 */
export type PhoneState =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unpaired"; readonly lastSyncAt: Date | null }
  | {
      readonly kind: "locked";
      readonly session: GmSessionRecord;
      readonly lastSyncAt: Date | null;
      readonly lastSyncError: string | null;
    }
  | {
      readonly kind: "unlocked";
      readonly session: GmSessionRecord;
      readonly dek: Dek;
      readonly lastSyncAt: Date | null;
      readonly lastSyncError: string | null;
    };

const DB_ERROR =
  "Could not load your phone status because the database did not respond. Your pairing is unchanged; reload the page to try again.";

/** Memoized per request so several dashboard sections share one unlock. */
export const loadPhoneState = cache(async (userId: string): Promise<PhoneState> => {
  const cookieHeader = (await headers()).get("cookie");
  const db = getDb();
  const [record, sync] = await Promise.all([SessionStore.readRecord(db, userId), SyncState.read(db, userId)]);
  if (record.isErr()) {
    console.error(`[dashboard] ${describeForLog(record.error)}`);
    return { kind: "error", message: DB_ERROR };
  }
  const lastSyncAt = sync.isOk() ? sync.value.lastSyncAt : null;
  const lastSyncError = sync.isOk() ? sync.value.lastSyncError : null;
  const session = record.value;
  if (session === null || session.status === "unpaired") return { kind: "unpaired", lastSyncAt };

  const unlocked = await DeviceUnlock.unlock(db, userId, cookieHeader);
  if (unlocked.isErr()) {
    if (unlocked.error._tag === "VaultStorageError") {
      console.error(`[dashboard] ${describeForLog(unlocked.error)}`);
      return { kind: "error", message: DB_ERROR };
    }
    return { kind: "locked", session, lastSyncAt, lastSyncError };
  }
  // A device slot for an older key cannot open data sealed with the current one.
  if (unlocked.value.id !== session.dekId) return { kind: "locked", session, lastSyncAt, lastSyncError };
  return { kind: "unlocked", session, dek: unlocked.value, lastSyncAt, lastSyncError };
});

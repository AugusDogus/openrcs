import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { SessionStore, type GmSessionRecord } from "@/lib/rcs/session-store";
import { SyncState } from "@/lib/rcs/sync-state";
import { ServerKey } from "@/lib/vault";

/**
 * What the dashboard shows for the signed-in user. Paired means a session
 * and the server key that opens it; a session without a usable key cannot be
 * read, so it counts as unpaired and the page offers pairing.
 */
export type PhoneState =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unpaired" }
  | {
      readonly kind: "paired";
      readonly session: GmSessionRecord;
      readonly lastSyncAt: Date | null;
      readonly lastSyncError: string | null;
    };

const DB_ERROR =
  "Could not load your phone status because the database did not respond. Your pairing is unchanged; reload the page to try again.";

/** Memoized per request so several dashboard sections share one read. */
export const loadPhoneState = cache(async (userId: string): Promise<PhoneState> => {
  const db = getDb();
  const [record, sync, key] = await Promise.all([
    SessionStore.readRecord(db, userId),
    SyncState.read(db, userId),
    ServerKey.unlock(db, userId),
  ]);
  if (record.isErr()) {
    console.error(`[dashboard] ${describeForLog(record.error)}`);
    return { kind: "error", message: DB_ERROR };
  }
  if (key.isErr()) {
    console.error(`[dashboard] ${describeForLog(key.error)}`);
    if (key.error._tag === "VaultStorageError") return { kind: "error", message: DB_ERROR };
  }
  const session = record.value;
  if (session === null || session.status === "unpaired" || !key.isOk() || key.value === null) {
    return { kind: "unpaired" };
  }
  return {
    kind: "paired",
    session,
    lastSyncAt: sync.isOk() ? sync.value.lastSyncAt : null,
    lastSyncError: sync.isOk() ? sync.value.lastSyncError : null,
  };
});

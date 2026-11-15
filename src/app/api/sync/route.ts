import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { describePhoneError } from "@/lib/rcs/phone";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { SyncLimits, syncUser, type SyncError } from "@/lib/rcs/sync";
import { ServerKey } from "@/lib/vault";

/** Dashboard "Sync now": incremental sync, unlocked with the user's server key. */

const SYNC_BUDGET_MS = 45_000;

const statusFor = (error: SyncError): number => {
  switch (error._tag) {
    case "RcsNotPairedError":
    case "RcsNeedsRepairError":
    case "RcsKeyMismatchError":
    case "RcsPhoneBusyError":
      return 409;
    case "RcsPhoneError":
      return error.needsRepair ? 409 : 502;
    case "RcsAbortedError":
      return 499;
    case "RcsSessionCorruptError":
    case "RcsStorageError":
      return 503;
  }
};

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);
  const { userId } = signedIn.value;
  const db = getDb();

  const unlocked = await ServerKey.unlock(db, userId);
  if (unlocked.isErr()) {
    console.error(`[api:sync] unlock failed: ${describeForLog(unlocked.error)}`);
    return RequestGuard.errorResponse(
      unlocked.error._tag === "VaultStorageError" ? 503 : 409,
      unlocked.error._tag === "VaultStorageError"
        ? "openrcs could not unlock your data because the database did not respond. Nothing was changed; try again in a moment."
        : "openrcs cannot open your stored data with this server's key. Nothing was changed. Pair your phone again to replace the key.",
    );
  }
  if (unlocked.value === null) {
    return RequestGuard.errorResponse(409, "No phone is paired with this openrcs account. Pair your phone first.");
  }

  const synced = await syncUser(db, { userId, dek: unlocked.value }, {
    ...SyncLimits.incremental,
    deadlineMs: startedAt + SYNC_BUDGET_MS,
    signal: request.signal,
  });
  if (synced.isErr()) {
    console.warn(`[api:sync] sync failed: ${describeForLog(synced.error)}`);
    return RequestGuard.errorResponse(statusFor(synced.error), describePhoneError(synced.error));
  }
  return Response.json({ summary: synced.value }, { headers: { "cache-control": "no-store" } });
}

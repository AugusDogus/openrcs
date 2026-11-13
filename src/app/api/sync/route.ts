import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { describePhoneError } from "@/lib/rcs/phone";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { SyncLimits, syncUser, type SyncError } from "@/lib/rcs/sync";
import { DeviceUnlock } from "@/lib/vault";

/** Dashboard "Sync now": incremental sync unlocked by this browser's device cookie. */

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
  const { userId, cookieHeader } = signedIn.value;
  const db = getDb();

  const unlocked = await DeviceUnlock.unlock(db, userId, cookieHeader);
  if (unlocked.isErr()) {
    if (unlocked.error._tag === "VaultLockedError") {
      return RequestGuard.errorResponse(423, unlocked.error.message);
    }
    console.error(`[api:sync] unlock failed: ${describeForLog(unlocked.error)}`);
    return RequestGuard.errorResponse(
      503,
      "openrcs could not unlock your data because the database did not respond. Nothing was changed; try again in a moment.",
    );
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

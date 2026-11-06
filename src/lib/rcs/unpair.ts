import { Result } from "better-result";
import type { Database } from "@/lib/db/client";
import { DeviceUnlock, Vault, type VaultStorageError } from "@/lib/vault";
import { describeForLog, GmFailure, type RcsStorageError } from "./errors";
import { withPhone } from "./phone";
import { SessionStore } from "./session-store";
import { deleteUserData } from "./store";

export type UnpairSummary = {
  /** True when the phone was told to drop this web session (best effort). */
  readonly phoneNotified: boolean;
};

/**
 * Unpair: if this browser can unlock the session, ask Google to drop the web
 * device (best effort); then delete stored conversations/messages/sync state,
 * the gm_session row, and every key slot and grant. The caller clears the
 * device cookie with `Vault.clearDeviceCookie()`.
 */
export const unpairUser = async (
  db: Database,
  opts: { readonly userId: string; readonly cookieHeader: string | null },
): Promise<Result<UnpairSummary, RcsStorageError | VaultStorageError>> => {
  const { userId } = opts;
  let phoneNotified = false;
  const unlocked = await DeviceUnlock.unlock(db, userId, opts.cookieHeader);
  if (unlocked.isOk()) {
    const unpaired = await withPhone(
      db,
      { userId, dek: unlocked.value },
      async (client) => {
        const result = await client.unpair();
        return result.isOk()
          ? Result.ok(undefined)
          : Result.err(GmFailure.toPhoneError(userId, "unpair", result.error));
      },
      { operation: "unpair", lease: { waitMs: 5_000 }, requestTimeoutMs: 10_000 },
    );
    phoneNotified = unpaired.isOk();
    if (unpaired.isErr()) {
      console.warn(`[rcs:unpair] telling the phone failed (continuing): ${describeForLog(unpaired.error)}`);
    }
  }

  const deleted = await deleteUserData(db, userId);
  if (deleted.isErr()) return Result.err(deleted.error);
  const session = await SessionStore.delete(db, userId);
  if (session.isErr()) return Result.err(session.error);
  const revoked = await Vault.revokeAll(db, userId);
  if (revoked.isErr()) return Result.err(revoked.error);
  return Result.ok({ phoneNotified });
};

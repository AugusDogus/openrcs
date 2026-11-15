import { Result } from "better-result";
import type { Database } from "@/lib/db/client";
import { ServerKey, Vault, VaultConfig, type VaultStorageError } from "@/lib/vault";
import { describeForLog, GmFailure, type RcsPhoneBusyError, type RcsStorageError } from "./errors";
import { FirstSync } from "./first-sync";
import { withPhone, type WithPhoneOptions } from "./phone";
import { PhoneLease, type AcquireOptions } from "./phone-lease";
import { SessionStore } from "./session-store";
import { deleteUserData } from "./store";

export type UnpairSummary = {
  /** True when the phone was told to drop this web session (best effort). */
  readonly phoneNotified: boolean;
};

export type UnpairOptions = {
  readonly userId: string;
  /** Waiting for an in-flight sync, send or pairing; default `UNPAIR_LEASE_WAIT_MS`. */
  readonly lease?: AcquireOptions;
  /** Defaults to `VaultConfig.fromEnv()`. */
  readonly vault?: VaultConfig;
  /** Tests inject a scripted phone (`createClient`). */
  readonly phone?: Pick<WithPhoneOptions, "createClient" | "fetch">;
};

/** Fits inside the unpair and account-delete routes' 60 s budget, with time left for the phone and the deletes. */
export const UNPAIR_LEASE_WAIT_MS = 30_000;

/**
 * Unpair: stop a running first sync, take the phone lease (waiting for any
 * sync, send or pairing in progress, so none of them can store rows or
 * re-create the session after the deletes); ask Google to drop the web device (best effort); then delete
 * stored conversations/messages/sync state, the gm_session row, every key
 * slot and grant, and the server key. Fails with RcsPhoneBusyError, deleting
 * nothing, if the phone stays busy.
 */
export const unpairUser = async (
  db: Database,
  opts: UnpairOptions,
): Promise<Result<UnpairSummary, RcsPhoneBusyError | RcsStorageError | VaultStorageError>> => {
  const { userId } = opts;
  FirstSync.cancel(userId);
  const acquired = await PhoneLease.acquire(db, userId, { waitMs: UNPAIR_LEASE_WAIT_MS, ...opts.lease });
  if (acquired.isErr()) return Result.err(acquired.error);
  const lease = acquired.value;
  try {
    let phoneNotified = false;
    const unlocked = await ServerKey.unlockWith(db, opts.vault ?? VaultConfig.fromEnv(), userId);
    if (unlocked.isErr()) {
      console.warn(`[rcs:unpair] cannot open the session to tell the phone (continuing): ${describeForLog(unlocked.error)}`);
    } else if (unlocked.value !== null) {
      const unpaired = await withPhone(
        db,
        { userId, dek: unlocked.value },
        async (client) => {
          const result = await client.unpair();
          return result.isOk()
            ? Result.ok(undefined)
            : Result.err(GmFailure.toPhoneError(userId, "unpair", result.error));
        },
        { operation: "unpair", lease: { held: lease }, requestTimeoutMs: 10_000, ...opts.phone },
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
    const key = await ServerKey.delete(db, userId);
    if (key.isErr()) return Result.err(key.error);
    return Result.ok({ phoneNotified });
  } finally {
    const released = await PhoneLease.release(db, lease);
    if (released.isErr()) console.warn(`[rcs:unpair] lease release failed: ${describeForLog(released.error)}`);
  }
};

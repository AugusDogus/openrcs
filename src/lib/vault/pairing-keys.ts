import { Result } from "better-result";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { VaultConfig } from "./config";
import { Dek } from "./dek";
import { DEVICE_SLOT_TTL_MS, DeviceCookie, DeviceUnlock } from "./device";
import { VaultErrors, VaultLockedError, type VaultStorageError } from "./errors";
import { KeySlot, type NewKeySlot } from "./key-slot";

/**
 * The DEK a pairing (or an OAuth consent) will use. Either the browser's
 * existing device slot unlocked it (`isNewKey: false`, nothing to persist),
 * or a new DEK was minted together with a new device slot that `commit`
 * persists and `setCookie` hands to the browser.
 */
export type PreparedPairingKey =
  | {
      readonly userId: string;
      readonly dek: Dek;
      readonly isNewKey: false;
      readonly setCookie: null;
    }
  | {
      readonly userId: string;
      readonly dek: Dek;
      /** true when no valid device slot existed, so this pairing mints a new DEK. */
      readonly isNewKey: true;
      /** Set-Cookie header value to send at the START of the response. */
      readonly setCookie: string;
      /** Row for the new device slot (verifier and wrapped DEK only; no secret). */
      readonly pendingDeviceSlot: NewKeySlot;
    };

export type PairingKeyMode = "pairing" | "consent";

const prepareWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
  cookieHeader: string | null,
  opts: { readonly mode: PairingKeyMode },
): Promise<Result<PreparedPairingKey, VaultLockedError | VaultStorageError>> => {
  const unlocked = await DeviceUnlock.unlockWith(db, config, userId, cookieHeader);
  if (unlocked.isOk()) {
    return Result.ok({ userId, dek: unlocked.value, isNewKey: false, setCookie: null });
  }
  if (unlocked.error._tag === "VaultStorageError") return Result.err(unlocked.error);

  if (opts.mode === "consent") {
    // Minting here would orphan the paired session's data, so consent must
    // come from a browser that can unlock it.
    const sessionDekId = await KeySlot.sessionDekId(db, userId);
    if (sessionDekId.isErr()) return Result.err(sessionDekId.error);
    if (sessionDekId.value !== null) {
      return Result.err(
        new VaultLockedError({
          userId,
          reason: "paired_elsewhere",
          message:
            "This browser cannot unlock your account: your phone was paired from a different browser. Nothing was changed. Approve from the browser you paired with, or re-pair your phone in this browser (that replaces the key and disconnects existing MCP clients).",
        }),
      );
    }
  }

  const dek = Dek.generate();
  const { values, credential } = KeySlot.mint(config, {
    userId,
    kind: "device",
    dek,
    expiresAt: config.now() + DEVICE_SLOT_TTL_MS,
  });
  return Result.ok({
    userId,
    dek,
    isNewKey: true,
    setCookie: DeviceCookie.serialize(config.deviceCookie, credential),
    pendingDeviceSlot: values,
  });
};

const commitWith = async (
  db: Database,
  config: VaultConfig,
  prepared: PreparedPairingKey,
  hooks: { readonly onKeyRotated: () => Promise<void> },
): Promise<Result<void, VaultStorageError>> => {
  if (!prepared.isNewKey) return Result.ok();
  const { userId, dek } = prepared;
  const now = config.now();

  // Everything sealed under an older DEK is unreadable from now on.
  const revoked = await Result.tryPromise({
    try: () =>
      db.batch([
        db
          .update(keySlot)
          .set({ revokedAt: now })
          .where(
            and(eq(keySlot.userId, userId), ne(keySlot.dekId, dek.id), isNull(keySlot.revokedAt)),
          ),
        db
          .update(oauthGrant)
          .set({ revokedAt: now, revokedReason: "key_rotated" })
          .where(
            and(
              eq(oauthGrant.userId, userId),
              ne(oauthGrant.dekId, dek.id),
              isNull(oauthGrant.revokedAt),
            ),
          ),
      ]),
    catch: (cause) => VaultErrors.storage("revoke slots and grants on key rotation", userId, cause),
  });
  if (revoked.isErr()) return Result.err(revoked.error);

  const rotated = await Result.tryPromise({
    try: () => hooks.onKeyRotated(),
    catch: (cause) => VaultErrors.storage("onKeyRotated hook (delete old encrypted data)", userId, cause),
  });
  if (rotated.isErr()) return Result.err(rotated.error);

  return Result.tryPromise({
    try: async () => {
      await db.insert(keySlot).values(prepared.pendingDeviceSlot);
    },
    catch: (cause) => VaultErrors.storage("persist new device slot", userId, cause),
  });
};

export const PairingKeys = {
  /**
   * mode "pairing": use the device slot's DEK if valid, else mint a new DEK
   * (always succeeds). mode "consent" (OAuth approval): same, except that if
   * the user already has a gm_session and this browser cannot unlock it,
   * return VaultLockedError instead of minting.
   */
  prepare: (
    db: Database,
    userId: string,
    cookieHeader: string | null,
    opts: { readonly mode: PairingKeyMode },
  ): Promise<Result<PreparedPairingKey, VaultLockedError | VaultStorageError>> =>
    prepareWith(db, VaultConfig.fromEnv(), userId, cookieHeader, opts),
  /**
   * If isNewKey: revoke every older slot and grant of the user, call
   * `onKeyRotated` (the service layer deletes the old encrypted rows there)
   * BEFORE the caller writes the new gm_session, then persist the device slot
   * announced by setCookie. No-op otherwise.
   */
  commit: (
    db: Database,
    prepared: PreparedPairingKey,
    hooks: { readonly onKeyRotated: () => Promise<void> },
  ): Promise<Result<void, VaultStorageError>> =>
    commitWith(db, VaultConfig.fromEnv(), prepared, hooks),
  prepareWith,
  commitWith,
} as const;

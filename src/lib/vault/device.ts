import { Result } from "better-result";
import type { Database } from "@/lib/db/client";
import { VaultConfig, type DeviceCookieSettings } from "./config";
import type { Dek } from "./dek";
import { VaultLockedError, type KeySlotRejection, type VaultStorageError } from "./errors";
import { KeySlot, SlotCredential } from "./key-slot";

/**
 * The browser key slot. Its secret lives only in an HttpOnly cookie
 * `<slotId>.<base64url secret>`; see docs/security.md.
 */
export const DEVICE_COOKIE = VaultConfig.SECURE_DEVICE_COOKIE;

/** Device slots (and their cookie) last one year. */
export const DEVICE_SLOT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const cookieAttributes = (settings: DeviceCookieSettings, maxAgeSeconds: number) =>
  [
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(settings.secure ? ["Secure"] : []),
  ].join("; ");

export const DeviceCookie = {
  /** The raw cookie value from a Cookie header, if present. */
  read: (settings: DeviceCookieSettings, cookieHeader: string | null): string | undefined => {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(";")) {
      const index = part.indexOf("=");
      if (index === -1) continue;
      if (part.slice(0, index).trim() === settings.name) return part.slice(index + 1).trim();
    }
    return undefined;
  },
  parse: (value: string): SlotCredential | undefined => SlotCredential.parse("", value),
  /** Set-Cookie header value storing `credential` for one year. */
  serialize: (settings: DeviceCookieSettings, credential: SlotCredential): string =>
    `${settings.name}=${SlotCredential.format("", credential)}; ${cookieAttributes(
      settings,
      DEVICE_SLOT_TTL_MS / 1000,
    )}`,
  /** Set-Cookie header value deleting the device cookie. */
  clear: (settings: DeviceCookieSettings): string =>
    `${settings.name}=; ${cookieAttributes(settings, 0)}`,
} as const;

const describe: Record<VaultLockedError["reason"], string> = {
  no_cookie: "it has no device key",
  malformed_cookie: "its device key is malformed",
  paired_elsewhere: "your phone was paired from a different browser",
  not_found: "its device key is unknown",
  wrong_kind: "its device key is unknown",
  wrong_user: "its device key belongs to another account",
  wrong_secret: "its device key does not match",
  revoked: "its device key was revoked",
  expired: "its device key expired",
  stale_key: "its device key is for an older pairing",
  unwrap_failed: "its device key does not match",
};

const locked = (userId: string, reason: VaultLockedError["reason"]) =>
  new VaultLockedError({
    userId,
    reason,
    message: `This browser cannot unlock your openrcs data: ${describe[reason]}. Nothing was changed. Use the browser you paired your phone with, or re-pair your phone in this browser.`,
  });

const unlockWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
  cookieHeader: string | null,
): Promise<Result<Dek, VaultLockedError | VaultStorageError>> => {
  const value = DeviceCookie.read(config.deviceCookie, cookieHeader);
  if (value === undefined) return Result.err(locked(userId, "no_cookie"));
  const credential = DeviceCookie.parse(value);
  if (!credential) return Result.err(locked(userId, "malformed_cookie"));
  const opened = await KeySlot.open(db, config, { credential, kind: "device", userId });
  if (opened.isOk()) return Result.ok(opened.value.dek);
  const error = opened.error;
  switch (error._tag) {
    case "VaultStorageError":
      return Result.err(error);
    case "KeySlotConsumedError":
      // Device slots are never consumed; treat an unexpected mark as revoked.
      return Result.err(locked(userId, "revoked" satisfies KeySlotRejection));
    case "KeySlotInvalidError":
      return Result.err(locked(userId, error.reason));
  }
};

export const DeviceUnlock = {
  /**
   * Unwrap the user's DEK from the device cookie in `cookieHeader`.
   * Errors: VaultLockedError (no/invalid/revoked/stale slot: this browser
   * cannot unlock; the user re-pairs here or uses the browser that paired).
   */
  unlock: (
    db: Database,
    userId: string,
    cookieHeader: string | null,
  ): Promise<Result<Dek, VaultLockedError | VaultStorageError>> =>
    unlockWith(db, VaultConfig.fromEnv(), userId, cookieHeader),
  unlockWith,
} as const;

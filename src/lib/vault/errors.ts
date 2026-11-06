import { TaggedError } from "better-result";
import type { KeySlotKind } from "@/lib/db/vault-schema";

/** Why a key slot could not be used. None of these reveal whether a secret was close. */
export type KeySlotRejection =
  | "not_found"
  | "wrong_kind"
  | "wrong_user"
  | "wrong_secret"
  | "revoked"
  | "expired"
  | "stale_key"
  | "unwrap_failed";

/**
 * This browser cannot unlock the user's DEK: no device cookie, or its slot is
 * unknown, revoked, expired, for an older key, or does not match. Nothing was
 * changed. The user re-pairs in this browser or uses the browser that paired.
 */
export class VaultLockedError extends TaggedError("VaultLockedError")<{
  userId: string;
  reason: "no_cookie" | "malformed_cookie" | "paired_elsewhere" | KeySlotRejection;
  message: string;
}> {}

/** A vault read or write failed in the database. Earlier committed state is intact. */
export class VaultStorageError extends TaggedError("VaultStorageError")<{
  operation: string;
  userId: string | null;
  cause: unknown;
  message: string;
}> {}

/** A presented slot credential (device cookie, code, refresh token) cannot be used. */
export class KeySlotInvalidError extends TaggedError("KeySlotInvalidError")<{
  slotId: string;
  kind: KeySlotKind;
  reason: KeySlotRejection;
  message: string;
}> {}

/**
 * The slot credential is genuine but was already used (a redeemed code or a
 * rotated refresh token). Callers decide whether this is a benign retry or a
 * replay that must revoke the grant.
 */
export class KeySlotConsumedError extends TaggedError("KeySlotConsumedError")<{
  slotId: string;
  kind: KeySlotKind;
  grantId: string | null;
  consumedAt: number;
  message: string;
}> {}

export const VaultErrors = {
  storage: (operation: string, userId: string | null, cause: unknown) =>
    new VaultStorageError({
      operation,
      userId,
      cause,
      message: `Vault operation "${operation}" failed in the database${userId === null ? "" : ` for user ${userId}`}. Previously committed keys and grants are unchanged; retry, and check database connectivity (TURSO_DATABASE_URL) if it persists.`,
    }),
} as const;

import { TaggedError } from "better-result";
import type { KeySlotKind } from "@/lib/db/vault-schema";

/** Why a key slot could not be used. None of these reveal whether a secret was close. */
export type KeySlotRejection = "not_found" | "wrong_kind" | "wrong_user" | "wrong_secret" | "revoked" | "expired";

/** A vault read or write failed in the database. Earlier committed state is intact. */
export class VaultStorageError extends TaggedError("VaultStorageError")<{
  operation: string;
  userId: string | null;
  cause: unknown;
  message: string;
}> {}

/** A presented slot credential (authorization code, refresh token) cannot be used. */
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
      message: `Vault operation "${operation}" failed in the database${userId === null ? "" : ` for user ${userId}`}. Previously committed keys and grants are unchanged; retry, and check database connectivity (DATABASE_URL) if it persists.`,
    }),
} as const;

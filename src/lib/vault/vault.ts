import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { VaultErrors, type VaultStorageError } from "./errors";

const revokeAll = (db: Database, userId: string): Promise<Result<void, VaultStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.batch([
        db.delete(keySlot).where(eq(keySlot.userId, userId)),
        db.delete(oauthGrant).where(eq(oauthGrant.userId, userId)),
      ]);
    },
    catch: (cause) => VaultErrors.storage("delete all key slots and grants", userId, cause),
  });

export const Vault = {
  /** Unpair/delete: revoke and delete every slot and grant of the user. */
  revokeAll,
} as const;

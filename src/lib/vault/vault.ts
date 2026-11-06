import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { Env } from "@/lib/env";
import { VaultConfig, type DeviceCookieSettings } from "./config";
import { DeviceCookie } from "./device";
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
  /** Set-Cookie header value removing the device cookie. */
  clearDeviceCookie: (): string =>
    DeviceCookie.clear(VaultConfig.deviceCookieFor(Env.auth().BETTER_AUTH_URL)),
  clearDeviceCookieWith: (settings: DeviceCookieSettings): string => DeviceCookie.clear(settings),
} as const;

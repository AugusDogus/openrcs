import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { account, session, user } from "@/lib/db/auth-schema";
import { phoneLease } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { RcsStorageError } from "./errors";

/**
 * Delete the Better Auth user and its sessions and linked GitHub account.
 * Run after `unpairUser` (which removes phone data, slots and grants). Rows
 * are deleted explicitly rather than relying on foreign-key cascades.
 */
export const deleteAccountRows = (db: Database, userId: string): Promise<Result<void, RcsStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.batch([
        db.delete(phoneLease).where(eq(phoneLease.userId, userId)),
        db.delete(session).where(eq(session.userId, userId)),
        db.delete(account).where(eq(account.userId, userId)),
        db.delete(user).where(eq(user.id, userId)),
      ]);
    },
    catch: (cause) =>
      new RcsStorageError({
        operation: "account.delete",
        userId,
        cause,
        message:
          "Your phone data and agent access were removed, but deleting the account itself failed because the database did not respond. Try deleting the account again.",
      }),
  });

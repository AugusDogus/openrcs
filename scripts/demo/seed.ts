/**
 * Demo database writes for ./record.ts, made with the app's own modules so
 * the server-rendered dashboard shows exactly what a real pairing leaves
 * behind. Reads DATABASE_URL and KEY_PEPPER from the environment (set by
 * record.ts to a throwaway database and key).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { user } from "@/lib/db/auth-schema";
import { getDb } from "@/lib/db/client";
import { oauthClient, oauthGrant } from "@/lib/db/vault-schema";
import { AuthData } from "@/lib/gm/auth-data";
import { savePairing } from "@/lib/rcs/pairing";
import { SyncState } from "@/lib/rcs/sync-state";

const fail = (operation: string, error: { message: string }): never => {
  throw new Error(`demo seed: ${operation} failed: ${error.message}`);
};

export const Seed = {
  /** The id of the user Tailscale sign-in created for `email`. */
  userId: async (email: string): Promise<string> => {
    const [row] = await getDb().select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    if (row === undefined) throw new Error(`demo seed: no user ${email}; did the Tailscale sign-in run?`);
    return row.id;
  },

  /** What a confirmed pairing saves: a server key and a sealed session (with throwaway, never-used auth data). */
  pairPhone: async (userId: string, phoneId: string): Promise<void> => {
    const saved = await savePairing(getDb(), {
      userId,
      paired: { authData: AuthData.createForPairing(), phoneId },
    });
    if (saved.isErr()) fail("savePairing", saved.error);
  },

  /** What the end of the first sync records. */
  finishSync: async (userId: string): Promise<void> => {
    const recorded = await SyncState.recordSuccess(getDb(), userId);
    if (recorded.isErr()) fail("SyncState.recordSuccess", recorded.error);
  },

  /** A registered MCP client the user approved, as the consent page leaves it. */
  connectAgent: async (userId: string, clientName: string): Promise<void> => {
    const clientId = randomUUID();
    const db = getDb();
    await db.insert(oauthClient).values({
      clientId,
      clientName,
      redirectUrisJson: JSON.stringify(["http://localhost:53682/callback"]),
      tokenEndpointAuthMethod: "none",
      scope: "messages:read messages:send",
    });
    await db.insert(oauthGrant).values({ id: randomUUID(), userId, clientId, scope: "messages:read messages:send" });
  },
} as const;

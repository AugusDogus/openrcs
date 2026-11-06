import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import { gmSession, type GmSessionKind, type GmSessionStatus } from "./app-schema";
import type { Database } from "./client";

/** Reading the user's gm_session row failed (database unreachable or misconfigured). */
export class PairingStatusReadError extends TaggedError("PairingStatusReadError")<{
  userId: string;
  cause: unknown;
  message: string;
}> {}

/**
 * The phone pairing state shown to users and MCP clients. A user without a
 * gm_session row is `unpaired` with no kind. Never includes `auth_data_enc`.
 */
export type PairingStatus = {
  readonly status: GmSessionStatus;
  readonly kind: GmSessionKind | null;
  readonly phoneLabel: string | null;
  readonly lastConnectedAt: Date | null;
  readonly lastError: string | null;
};

const unpaired: PairingStatus = {
  status: "unpaired",
  kind: null,
  phoneLabel: null,
  lastConnectedAt: null,
  lastError: null,
};

const read = (
  db: Database,
  userId: string,
): Promise<Result<PairingStatus, PairingStatusReadError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db
        .select({
          status: gmSession.status,
          kind: gmSession.kind,
          phoneLabel: gmSession.phoneLabel,
          lastConnectedAt: gmSession.lastConnectedAt,
          lastError: gmSession.lastError,
        })
        .from(gmSession)
        .where(eq(gmSession.userId, userId))
        .limit(1);
      return row ?? unpaired;
    },
    catch: (cause) =>
      new PairingStatusReadError({
        userId,
        cause,
        message: `Could not read the phone pairing status for user ${userId} from the database.`,
      }),
  });

export const PairingStatus = {
  unpaired,
  read,
} as const;

import { z } from "zod";

/**
 * Body of GET /api/sync/status: whether the first sync after pairing is
 * still running, and how far it got. Shared by the route and the dashboard,
 * so it must stay free of server-only imports.
 */
export const FirstSyncStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    done: z.number().int().nonnegative(),
    /** Null until the phone has listed the conversations to sync. */
    total: z.number().int().nonnegative().nullable(),
  }),
  z.object({ state: z.literal("idle") }),
]);

export type FirstSyncStatus = z.infer<typeof FirstSyncStatusSchema>;

/** A running first sync's progress; `total` is null until the phone has listed the conversations to sync. */
export type FirstSyncProgress = { readonly done: number; readonly total: number | null };

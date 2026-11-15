import { connection } from "next/server";
import { FirstSync } from "@/lib/rcs/first-sync";
import type { FirstSyncStatus } from "@/lib/rcs/first-sync-status";
import { RequestGuard } from "@/lib/rcs/request-guard";

/** The signed-in user's first-sync progress, polled by the dashboard while it runs. */
export async function GET(request: Request): Promise<Response> {
  await connection();
  const signedIn = await RequestGuard.requireSession(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);
  const progress = FirstSync.progress(signedIn.value.userId);
  const body: FirstSyncStatus = progress === null ? { state: "idle" } : { state: "running", ...progress };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

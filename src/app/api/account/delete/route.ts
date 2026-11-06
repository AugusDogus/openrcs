import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { deleteAccountRows } from "@/lib/rcs/account";
import { describeForLog } from "@/lib/rcs/errors";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { unpairUser } from "@/lib/rcs/unpair";
import { Vault } from "@/lib/vault";

/** Delete everything: unpair (phone data, slots, grants), sign out, then the account rows. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);
  const db = getDb();

  const unpaired = await unpairUser(db, signedIn.value);
  if (unpaired.isErr()) {
    if (unpaired.error._tag === "RcsPhoneBusyError") {
      return RequestGuard.errorResponse(
        409,
        "openrcs is still busy with your phone (a sync, send or pairing). Nothing was deleted and your account still exists; try again in a minute.",
      );
    }
    console.error(`[api:account-delete] unpair failed: ${describeForLog(unpaired.error)}`);
    return RequestGuard.errorResponse(
      503,
      "Deleting your account did not finish because the database did not respond. Your account still exists; try again.",
    );
  }

  // Sign out first (it needs the session row) to get the cookie-clearing headers.
  const headers = new Headers({ "cache-control": "no-store" });
  try {
    const signedOut = await getAuth().api.signOut({ headers: request.headers, returnHeaders: true });
    for (const cookie of signedOut.headers.getSetCookie()) headers.append("set-cookie", cookie);
  } catch (error) {
    console.warn(
      `[api:account-delete] sign-out before deletion failed (continuing): ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  headers.append("set-cookie", Vault.clearDeviceCookie(signedIn.value.userId));

  const deleted = await deleteAccountRows(db, signedIn.value.userId);
  if (deleted.isErr()) {
    console.error(`[api:account-delete] failed: ${describeForLog(deleted.error)}`);
    return RequestGuard.errorResponse(503, deleted.error.message, headers);
  }
  return Response.json({ ok: true }, { headers });
}

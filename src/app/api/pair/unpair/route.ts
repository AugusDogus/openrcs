import { getDb } from "@/lib/db/client";
import { describeForLog } from "@/lib/rcs/errors";
import { RequestGuard } from "@/lib/rcs/request-guard";
import { unpairUser } from "@/lib/rcs/unpair";
import { Vault } from "@/lib/vault";

/**
 * Unpair: best-effort unpair on the phone, then delete stored messages, the
 * session, every key slot and grant, and the device cookie.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const signedIn = await RequestGuard.requireSignedIn(request);
  if (signedIn.isErr()) return RequestGuard.errorResponse(signedIn.error.status, signedIn.error.message);

  const unpaired = await unpairUser(getDb(), signedIn.value);
  if (unpaired.isErr()) {
    if (unpaired.error._tag === "RcsPhoneBusyError") {
      return RequestGuard.errorResponse(
        409,
        "openrcs is still busy with your phone (a sync, send or pairing). Nothing was deleted; try Unpair again in a minute.",
      );
    }
    console.error(`[api:unpair] failed: ${describeForLog(unpaired.error)}`);
    return RequestGuard.errorResponse(
      503,
      "Unpairing did not finish because the database did not respond. Some stored data may remain; try Unpair again.",
    );
  }
  return Response.json(
    { ok: true, phoneNotified: unpaired.value.phoneNotified },
    { headers: { "cache-control": "no-store", "set-cookie": Vault.clearDeviceCookie(signedIn.value.userId) } },
  );
}

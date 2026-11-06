import { handlePairingRequest } from "@/lib/rcs/pairing-http";

/** Google-account pairing: body `{ cookies }`, response text/event-stream of PairingEvents. */
export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return handlePairingRequest(request);
}

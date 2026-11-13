import { handlePairingRequest } from "@/lib/rcs/pairing-http";

/** Google-account pairing with the sign-in browser's cookies; response is a text/event-stream of PairingEvents. */

export function POST(request: Request): Promise<Response> {
  return handlePairingRequest(request);
}

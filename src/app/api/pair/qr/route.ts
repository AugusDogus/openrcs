import { handlePairingRequest } from "@/lib/rcs/pairing-http";

/** QR pairing: no body, response text/event-stream of PairingEvents (QR refreshes every 30 s). */
export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return handlePairingRequest(request, "qr");
}

import { handlePairingBrowserAction } from "@/lib/pairing-browser/http";

/** Self-hosted sign-in browser: body `{ action: "start" | "poll" | "finish" | "stop" }`. */
export function POST(request: Request): Promise<Response> {
  return handlePairingBrowserAction(request);
}

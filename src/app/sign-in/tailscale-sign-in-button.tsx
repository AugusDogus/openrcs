"use client";

import { useState } from "react";
import { Alert, buttonClass } from "@/app/_components/ui";

/**
 * Turns the Tailscale identity that Serve attached to this browser's requests
 * into a session. `callbackURL` must already be a validated same-origin
 * relative path (see ./callback-url.ts).
 */
export function TailscaleSignInButton({ login, callbackURL }: { login: string; callbackURL: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/tailscale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) {
        window.location.assign(callbackURL);
        return;
      }
      setError(
        response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "openrcs could not confirm your Tailscale identity. Reload the page and try again.",
      );
    } catch {
      setError("Could not reach openrcs. Check your Tailscale connection and try again.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <button type="button" onClick={signIn} disabled={pending} className={buttonClass("primary", "w-full")}>
        {pending ? "Signing in…" : `Continue as ${login}`}
      </button>
    </div>
  );
}

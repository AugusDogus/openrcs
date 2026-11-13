"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, buttonClass } from "@/app/_components/ui";

/**
 * Turns the Tailscale identity that Serve attached to this browser's requests
 * into a session, as soon as the page loads: the identity is already proven,
 * so there is nothing to ask. `callbackURL` must already be a validated
 * same-origin relative path (see ./callback-url.ts).
 */
export function TailscaleSignIn({ login, callbackURL }: { login: string; callbackURL: string }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function signIn() {
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/tailscale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) {
        window.location.replace(callbackURL);
        return;
      }
      setError(
        response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "openrcs could not confirm your Tailscale identity. Try again.",
      );
    } catch {
      setError("Could not reach openrcs. Check your Tailscale connection and try again.");
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signIn();
  });

  if (error === null) {
    return (
      <p className="flex items-center gap-2.5 text-sm text-muted" role="status">
        <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />
        Signing in as {login}…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="danger">{error}</Alert>
      <div className="flex justify-end">
        <button type="button" onClick={() => void signIn()} className={buttonClass("primary")}>
          Try again
        </button>
      </div>
    </div>
  );
}

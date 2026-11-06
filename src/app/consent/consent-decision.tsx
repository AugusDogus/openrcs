"use client";

import { useState } from "react";
import { Alert, buttonClass } from "@/app/_components/ui";
import { authClient } from "@/lib/auth-client";

type Decision = "approve" | "deny";

/**
 * Approve / Deny buttons. The auth client sends the signed OAuth query from
 * the page URL and follows the redirect back to the MCP client.
 */
export function ConsentDecision() {
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision) {
    setPending(decision);
    setError(null);
    const { error: consentError } = await authClient.oauth2.consent({
      accept: decision === "approve",
    });
    if (consentError) {
      setError(
        consentError.message ||
          "Could not record your decision. Nothing was shared. Return to your MCP client and start the connection again.",
      );
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => decide("deny")}
          disabled={pending !== null}
          className={buttonClass("secondary", "sm:flex-1")}
        >
          {pending === "deny" ? "Denying…" : "Deny"}
        </button>
        <button
          type="button"
          onClick={() => decide("approve")}
          disabled={pending !== null}
          className={buttonClass("primary", "sm:flex-1")}
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
    </div>
  );
}

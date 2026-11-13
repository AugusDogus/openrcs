"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Alert, buttonClass } from "@/app/_components/ui";

/** Dashboard buttons that POST to the service-layer routes and refresh the page. */

type Outcome = { readonly tone: "success" | "danger"; readonly text: string } | null;

const errorText = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Not JSON; use the fallback.
  }
  return fallback;
};

const post = (path: string) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

const summaryText = (body: unknown): string => {
  if (typeof body !== "object" || body === null || !("summary" in body)) return "Synced.";
  const summary = body.summary;
  if (typeof summary !== "object" || summary === null) return "Synced.";
  const stored = "messagesStored" in summary && typeof summary.messagesStored === "number" ? summary.messagesStored : 0;
  const partial = "deadlineReached" in summary && summary.deadlineReached === true;
  return `Synced ${stored} message${stored === 1 ? "" : "s"}${partial ? " (partial; the rest syncs next time)" : ""}.`;
};

export function SyncNowButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function sync() {
    setPending(true);
    setOutcome(null);
    try {
      const response = await post("/api/sync");
      if (response.ok) {
        setOutcome({ tone: "success", text: summaryText(await response.json()) });
      } else {
        setOutcome({ tone: "danger", text: await errorText(response, "Sync failed. Try again in a moment.") });
      }
    } catch {
      setOutcome({ tone: "danger", text: "Could not reach openrcs. Check your connection and try again." });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={sync} disabled={pending} className={buttonClass("secondary")}>
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {outcome ? <Alert tone={outcome.tone}>{outcome.text}</Alert> : null}
    </div>
  );
}

/** Two-step destructive action: the first click asks, the second does it. */
function ConfirmAction({
  label,
  confirmLabel,
  warning,
  path,
  onDone,
}: {
  label: string;
  confirmLabel: string;
  warning: ReactNode;
  path: string;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<"idle" | "confirm" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setStage("pending");
    setError(null);
    try {
      const response = await post(path);
      if (response.ok) {
        onDone();
        return;
      }
      setError(await errorText(response, "That did not work. Nothing was changed; try again."));
    } catch {
      setError("Could not reach openrcs. Check your connection and try again.");
    }
    setStage("confirm");
  }

  if (stage === "idle") {
    return (
      <button type="button" onClick={() => setStage("confirm")} className={buttonClass("ghost", "text-danger")}>
        {label}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p className="text-sm leading-6 text-muted">{warning}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => setStage("idle")}
          disabled={stage === "pending"}
          className={buttonClass("secondary")}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={run}
          disabled={stage === "pending"}
          className={buttonClass("primary", "bg-danger hover:bg-danger")}
        >
          {stage === "pending" ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function UnpairButton() {
  const router = useRouter();
  return (
    <ConfirmAction
      label="Unpair phone"
      confirmLabel="Unpair and delete stored messages"
      warning="Unpairing removes openrcs from your phone's Google Messages, deletes every stored conversation and message, and disconnects all connected agents. You can pair again later."
      path="/api/pair/unpair"
      onDone={() => router.refresh()}
    />
  );
}

export function DeleteAccountButton() {
  const router = useRouter();
  return (
    <ConfirmAction
      label="Delete account"
      confirmLabel="Delete my account"
      warning="This unpairs your phone, deletes all stored messages, disconnects every agent, and deletes your openrcs account. It cannot be undone."
      path="/api/account/delete"
      onDone={() => {
        router.replace("/sign-in");
        router.refresh();
      }}
    />
  );
}

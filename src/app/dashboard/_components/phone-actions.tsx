"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Actions, Alert, buttonClass, Spinner } from "@/app/_components/ui";

/** Dashboard controls that POST to the service-layer routes and refresh the page. */

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

type Tone = "ok" | "warning" | "idle";

const dotTone: Record<Tone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  idle: "bg-muted",
};

/** A confirmation strip that replaces the row's buttons for destructive actions. */
function Confirm({
  warning,
  confirmLabel,
  path,
  onDone,
  onCancel,
}: {
  warning: ReactNode;
  confirmLabel: string;
  path: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const response = await post(path);
      if (response.ok) return onDone();
      setError(await errorText(response, "That did not work. Nothing was changed; try again."));
    } catch {
      setError("Could not reach openrcs. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border p-4">
      <p className="text-sm leading-6 text-muted">{warning}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Actions>
        <button type="button" onClick={onCancel} disabled={pending} className={buttonClass("secondary")}>
          Cancel
        </button>
        <button type="button" onClick={run} disabled={pending} className={buttonClass("danger")}>
          {pending ? <Spinner className="size-3.5" /> : null}
          {confirmLabel}
        </button>
      </Actions>
    </div>
  );
}

/**
 * The phone: status on the left, what you can do on the right. `repair`
 * links to re-pairing (when Google signed the device out, or this browser
 * cannot unlock the data); `canSync` shows Sync now.
 */
export function PhoneRow({
  name,
  status,
  tone,
  canSync,
  repair,
}: {
  name: string;
  status: string;
  tone: Tone;
  canSync: boolean;
  repair: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const response = await post("/api/sync");
      if (!response.ok) setSyncError(await errorText(response, "Sync failed. Try again in a moment."));
    } catch {
      setSyncError("Could not reach openrcs. Check your connection and try again.");
    }
    setSyncing(false);
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotTone[tone]}`} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-sm text-muted">{status}</p>
          </div>
        </div>
        {confirming ? null : (
          <Actions>
            <button type="button" onClick={() => setConfirming(true)} className={buttonClass("ghost")}>
              Unpair
            </button>
            {canSync ? (
              <button type="button" onClick={sync} disabled={syncing} className={buttonClass("secondary")}>
                {syncing ? <Spinner className="size-3.5" /> : null}
                {syncing ? "Syncing" : "Sync now"}
              </button>
            ) : null}
            {repair ? (
              <Link href="/dashboard/pair" prefetch={false} className={buttonClass("primary")}>
                {repair}
              </Link>
            ) : null}
          </Actions>
        )}
      </div>
      {syncError ? (
        <div className="border-t border-border p-4">
          <Alert tone="danger">{syncError}</Alert>
        </div>
      ) : null}
      {confirming ? (
        <Confirm
          warning="openrcs leaves your phone's Google Messages, deletes every stored message and disconnects your agents. You can pair again later."
          confirmLabel="Unpair"
          path="/api/pair/unpair"
          onDone={() => {
            setConfirming(false);
            router.refresh();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Actions, Alert, buttonClass, Spinner } from "@/app/_components/ui";
import { FirstSyncStatusSchema, type FirstSyncProgress } from "@/lib/rcs/first-sync-status";

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

const FIRST_SYNC_POLL_MS = 1_500;

/**
 * While the server's first sync runs, poll its progress; once it is over,
 * refresh the page so it shows the normal sync status (or the error).
 */
function useFirstSync(initial: FirstSyncProgress | null): FirstSyncProgress | null {
  const router = useRouter();
  const [progress, setProgress] = useState(initial);
  const running = initial !== null;
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const response = await fetch("/api/sync/status", { cache: "no-store" });
        const status = FirstSyncStatusSchema.safeParse(response.ok ? await response.json() : null);
        if (stopped || !status.success) return;
        if (status.data.state === "running") {
          setProgress({ done: status.data.done, total: status.data.total });
        } else {
          stopped = true;
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        // Offline for a moment; the next poll retries.
      } finally {
        polling = false;
      }
    }, FIRST_SYNC_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, router]);
  return running ? progress : null;
}

function FirstSyncStatus({ progress }: { progress: FirstSyncProgress }) {
  if (progress.total === null) {
    return (
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        Connecting to your phone
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      Syncing {progress.done} of {progress.total} conversations
    </span>
  );
}

/**
 * The phone: status on the left, what you can do on the right. `repair`
 * links to re-pairing (when Google signed the device out); `canSync` shows
 * Sync now. While `firstSync` runs, the row shows its progress, with a thin
 * bar along its bottom edge, and Sync now waits.
 */
export function PhoneRow({
  name,
  status,
  tone,
  canSync,
  repair,
  firstSync = null,
}: {
  name: string;
  status: string;
  tone: Tone;
  canSync: boolean;
  repair: string | null;
  firstSync?: FirstSyncProgress | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const progress = useFirstSync(firstSync);
  const percent =
    progress === null || progress.total === null
      ? null
      : progress.total === 0
        ? 100
        : Math.min(100, Math.round((progress.done / progress.total) * 100));

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
      <div className="relative flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotTone[tone]}`} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-sm text-muted" aria-live="polite">
              {progress === null ? status : <FirstSyncStatus progress={progress} />}
            </p>
          </div>
        </div>
        {confirming ? null : (
          <Actions>
            <button type="button" onClick={() => setConfirming(true)} className={buttonClass("ghost")}>
              Unpair
            </button>
            {canSync ? (
              <button
                type="button"
                onClick={sync}
                disabled={syncing || progress !== null}
                className={buttonClass("secondary")}
              >
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
        {percent === null ? null : (
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-muted">
            <div
              className="h-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
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

import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, AppShell, Section } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { timeAgo } from "@/app/_lib/time";
import { Env } from "@/lib/env";
import { FirstSync } from "@/lib/rcs/first-sync";
import type { FirstSyncProgress } from "@/lib/rcs/first-sync-status";
import { Agents } from "./_components/agents";
import { PhoneRow } from "./_components/phone-actions";
import { loadPhoneState, type PhoneState } from "./_lib/phone-state";
import { PairingFlow } from "./pair/_components/pairing-flow";

export const metadata: Metadata = { title: { absolute: "openrcs" } };

export default function DashboardPage() {
  return (
    <AppShell
      aside={
        <Suspense fallback={null}>
          <Identity />
        </Suspense>
      }
    >
      <Suspense fallback={<Skeleton />}>
        <Home />
      </Suspense>
    </AppShell>
  );
}

/** Who is signed in (your tailnet identity, so there is no sign-out). */
async function Identity() {
  const user = await requireCurrentUser();
  return (
    <span className="truncate text-sm text-muted" title={user.email}>
      {user.name || user.email}
    </span>
  );
}

/** Not paired yet: the page is the pairing. Paired: the phone and its agents. */
async function Home() {
  const user = await requireCurrentUser();
  const state = await loadPhoneState(user.id);
  if (state.kind === "error") return <Alert tone="danger">{state.message}</Alert>;
  if (state.kind === "unpaired") return <PairingFlow />;
  return (
    <>
      <Section title="Phone">
        <Phone state={state} firstSync={FirstSync.progress(user.id)} />
      </Section>
      <Suspense fallback={<div aria-hidden className="h-32 animate-pulse rounded-xl bg-surface-muted" />}>
        <Agents userId={user.id} mcpUrl={Env.mcpResourceUrl()} />
      </Suspense>
    </>
  );
}

function Phone({
  state,
  firstSync,
}: {
  state: Extract<PhoneState, { kind: "paired" }>;
  firstSync: FirstSyncProgress | null;
}) {
  const { session } = state;
  const name = session.phoneLabel ?? "Your phone";
  const lastError = session.lastError ?? state.lastSyncError;

  if (session.status === "needs_repair") {
    return (
      <PhoneRow
        name={name}
        status="Google signed openrcs out. Re-pair to resume; stored messages are kept."
        tone="warning"
        canSync={false}
        repair="Re-pair"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <PhoneRow
        // A new first sync remounts the row, so its progress starts fresh.
        key={firstSync === null ? "idle" : "first-sync"}
        name={name}
        status={state.lastSyncAt ? `Synced ${timeAgo(state.lastSyncAt)}` : "Paired, not synced yet"}
        tone="ok"
        canSync
        repair={null}
        firstSync={firstSync}
      />
      {lastError && firstSync === null ? <p className="text-sm leading-6 text-muted">Last error: {lastError}</p> : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <div className="h-6 w-24 rounded-md bg-surface-muted" />
      <div className="h-[74px] animate-pulse rounded-xl bg-surface-muted" />
    </div>
  );
}

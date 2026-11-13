import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { loadPhoneState } from "../_lib/phone-state";
import { PairingFlow } from "./_components/pairing-flow";

export const metadata: Metadata = { title: "Pair your phone" };

/** Re-pairing (the dashboard pairs inline when no phone is paired yet). */
export default function PairPage() {
  return (
    <AppShell>
      <Suspense fallback={<div aria-hidden className="aspect-[4/3] w-full animate-pulse rounded-xl bg-surface-muted" />}>
        <PairContent />
      </Suspense>
    </AppShell>
  );
}

async function PairContent() {
  const user = await requireCurrentUser();
  const state = await loadPhoneState(user.id);
  // Pairing from a browser that cannot unlock an existing session mints a new key.
  return <PairingFlow resetsData={state.kind === "locked"} />;
}

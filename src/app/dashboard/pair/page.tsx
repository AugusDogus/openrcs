import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
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
  await requireCurrentUser();
  return <PairingFlow />;
}

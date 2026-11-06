import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Wordmark } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { loadPhoneState } from "../_lib/phone-state";
import { PairingFlow } from "./_components/pairing-flow";

export const metadata: Metadata = { title: "Pair your phone" };

export default function PairPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4">
          <Wordmark />
          <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
            Back to dashboard
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:py-12">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pair your phone</h1>
          <p className="mt-1 text-sm text-muted">
            openrcs connects to your Android phone&apos;s Google Messages as a &quot;Messages for web&quot;
            device. Keep your phone on and online while pairing.
          </p>
        </div>
        <Suspense fallback={<div aria-hidden className="h-96 animate-pulse rounded-2xl border border-border bg-surface" />}>
          <PairContent />
        </Suspense>
      </main>
    </div>
  );
}

async function PairContent() {
  const user = await requireCurrentUser();
  const state = await loadPhoneState(user.id);
  // Pairing from a browser that cannot unlock an existing session mints a new key.
  const resetsData = state.kind === "locked";
  return <PairingFlow resetsData={resetsData} />;
}

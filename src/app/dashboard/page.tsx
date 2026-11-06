import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Alert, buttonClass, Card, Wordmark } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import type { GmSessionStatus } from "@/lib/db/app-schema";
import { getDb } from "@/lib/db/client";
import { Env } from "@/lib/env";
import { Store } from "@/lib/rcs/store";
import { AgentSetup } from "./_components/agent-setup";
import { ConnectedClients } from "./_components/connected-clients";
import { DeleteAccountButton, SyncNowButton, UnpairButton } from "./_components/phone-actions";
import { loadPhoneState, type PhoneState } from "./_lib/phone-state";
import { SignOutButton } from "./client-actions";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4">
          <Wordmark />
          <Suspense fallback={<div className="h-9 w-40 rounded-lg bg-surface-muted" />}>
            <UserMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:py-12">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Pair your phone, then connect an AI agent to read and send your messages.
          </p>
        </div>
        <Suspense fallback={<CardSkeleton />}>
          <PhoneCard />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <RecentConversations />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <AgentCard />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <ClientsCard />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <AccountCard />
        </Suspense>
      </main>
    </div>
  );
}

async function UserMenu() {
  const user = await requireCurrentUser();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm text-muted" title={user.email}>
        {user.name || user.email}
      </span>
      <SignOutButton />
    </div>
  );
}

const statusPresentation: Record<GmSessionStatus, { label: string; badge: string; description: string }> = {
  paired: {
    label: "Paired",
    badge: "bg-success-surface text-success",
    description: "Your phone is connected as a Google Messages for web device.",
  },
  needs_repair: {
    label: "Needs re-pairing",
    badge: "bg-warning-surface text-warning",
    description:
      "Google signed this device out, so openrcs cannot reach your phone. Pair again to resume syncing; stored messages are kept.",
  },
  unpaired: {
    label: "Not paired",
    badge: "bg-surface-muted text-muted",
    description:
      "Pair your Android phone's Google Messages so your agents can read and send messages.",
  },
};

// dateStyle/timeStyle cannot be combined with timeZoneName, so the zone is appended.
const timestampFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const formatTimestamp = (date: Date) => `${timestampFormat.format(date)} UTC`;

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function PhoneDetails({ state }: { state: Extract<PhoneState, { kind: "locked" | "unlocked" }> }) {
  const { session } = state;
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Detail label="Pairing" value={session.kind === "gaia" ? "Google account" : "QR code"} />
      <Detail
        label="Last connected"
        value={session.lastConnectedAt ? formatTimestamp(session.lastConnectedAt) : "Never"}
      />
      <Detail label="Last sync" value={state.lastSyncAt ? formatTimestamp(state.lastSyncAt) : "Never"} />
    </dl>
  );
}

async function PhoneCard() {
  const user = await requireCurrentUser();
  const state = await loadPhoneState(user.id);
  if (state.kind === "error") {
    return (
      <Card title="Phone">
        <Alert tone="danger">{state.message}</Alert>
      </Card>
    );
  }
  const status: GmSessionStatus = state.kind === "unpaired" ? "unpaired" : state.session.status;
  const presentation = statusPresentation[status];
  const phoneLabel = state.kind === "unpaired" ? null : state.session.phoneLabel;
  const lastError = state.kind === "unpaired" ? null : (state.session.lastError ?? state.lastSyncError);

  return (
    <Card title="Phone">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span
            className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${presentation.badge}`}
          >
            {presentation.label}
            {phoneLabel ? ` · ${phoneLabel}` : null}
          </span>
          <p className="text-sm leading-6 text-muted">{presentation.description}</p>
        </div>

        {state.kind === "unpaired" ? null : <PhoneDetails state={state} />}
        {lastError ? <p className="text-xs leading-5 text-muted">Last error: {lastError}</p> : null}

        {state.kind === "locked" ? (
          <Alert tone="warning">
            This browser cannot unlock your messages. Your data is encrypted with a key held by the browser
            that paired your phone (and by the agents you approved). Open openrcs there, or re-pair here:
            re-pairing from this browser creates a new key, which deletes the stored messages and
            disconnects connected agents.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          {state.kind === "unpaired" ? (
            <Link href="/dashboard/pair" prefetch={false} className={buttonClass("primary")}>
              Pair your phone
            </Link>
          ) : (
            <Link
              href="/dashboard/pair"
              prefetch={false}
              className={buttonClass(state.kind === "locked" || status === "needs_repair" ? "primary" : "secondary")}
            >
              {state.kind === "locked" ? "Re-pair here" : "Re-pair"}
            </Link>
          )}
          {state.kind === "unlocked" && status === "paired" ? <SyncNowButton /> : null}
          {state.kind === "unpaired" ? null : <UnpairButton />}
        </div>
      </div>
    </Card>
  );
}

async function RecentConversations() {
  const user = await requireCurrentUser();
  const state = await loadPhoneState(user.id);
  if (state.kind !== "unlocked") return null;
  const listed = await Store.listConversations(getDb(), { userId: user.id, dek: state.dek }, { limit: 8 });
  return (
    <Card title="Recent conversations" description="Decrypted in this request with this browser's key.">
      {listed.match({
        err: () => (
          <Alert tone="danger">
            Could not load your conversations right now. Nothing was changed; reload the page to try again.
          </Alert>
        ),
        ok: ({ conversations }) =>
          conversations.length === 0 ? (
            <p className="text-sm text-muted">
              No conversations stored yet. They appear after the first sync; use Sync now if your phone is
              paired.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {conversations.map((c) => (
                <li key={c.conversationId} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={`truncate text-sm ${c.unread ? "font-semibold" : "font-medium"}`}>
                      {c.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {formatTimestamp(new Date(c.lastMessageTimestampMs))}
                    </span>
                  </div>
                  {c.lastMessagePreview ? (
                    <p className="truncate text-sm text-muted">{c.lastMessagePreview}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ),
      })}
    </Card>
  );
}

async function AgentCard() {
  await connection();
  return <AgentSetup mcpUrl={Env.mcpResourceUrl()} />;
}

async function ClientsCard() {
  const user = await requireCurrentUser();
  return <ConnectedClients userId={user.id} />;
}

async function AccountCard() {
  await requireCurrentUser();
  return (
    <Card
      title="Account"
      description="Deleting your account removes your phone pairing, every stored message, all connected agents and your openrcs account."
    >
      <DeleteAccountButton />
    </Card>
  );
}

function CardSkeleton() {
  return <div aria-hidden className="h-44 animate-pulse rounded-2xl border border-border bg-surface" />;
}

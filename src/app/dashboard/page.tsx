import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Alert, buttonClass, Card, Wordmark } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import type { GmSessionStatus } from "@/lib/db/app-schema";
import { getDb } from "@/lib/db/client";
import { PairingStatus } from "@/lib/db/pairing-status";
import { Env } from "@/lib/env";
import { CopyButton, SignOutButton } from "./client-actions";

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
            Pair your phone, then connect an MCP client to read and send messages.
          </p>
        </div>
        <Suspense fallback={<CardSkeleton />}>
          <PhoneCard />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <McpCard />
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
        {user.email}
      </span>
      <SignOutButton />
    </div>
  );
}

const statusPresentation: Record<
  GmSessionStatus,
  { label: string; badge: string; description: string }
> = {
  paired: {
    label: "Paired",
    badge: "bg-success-surface text-success",
    description: "Your phone is connected as a Google Messages for web device.",
  },
  needs_repair: {
    label: "Needs re-pairing",
    badge: "bg-warning-surface text-warning",
    description:
      "Google signed this device out. Pair again to resume syncing; stored messages are kept.",
  },
  unpaired: {
    label: "Not paired",
    badge: "bg-surface-muted text-muted",
    description:
      "Pair your Android phone's Google Messages so MCP clients can read and send messages.",
  },
};

// dateStyle/timeStyle cannot be combined with timeZoneName, so the zone is appended.
const timestampFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const formatTimestamp = (date: Date) => `${timestampFormat.format(date)} UTC`;

async function PhoneCard() {
  const user = await requireCurrentUser();
  const result = await PairingStatus.read(getDb(), user.id);

  return (
    <Card title="Phone">
      {result.match({
        err: () => (
          <Alert tone="danger">
            Could not load your pairing status right now. Your pairing is unchanged; reload the
            page to try again.
          </Alert>
        ),
        ok: (pairing) => {
          const presentation = statusPresentation[pairing.status];
          return (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <span
                  className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${presentation.badge}`}
                >
                  {presentation.label}
                  {pairing.phoneLabel ? ` · ${pairing.phoneLabel}` : null}
                </span>
                <p className="text-sm leading-6 text-muted">{presentation.description}</p>
                {pairing.lastConnectedAt ? (
                  <p className="text-xs text-muted">
                    Last connected {formatTimestamp(pairing.lastConnectedAt)}
                  </p>
                ) : null}
                {pairing.status === "needs_repair" && pairing.lastError ? (
                  <p className="text-xs text-muted">Last error: {pairing.lastError}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link
                  href="/dashboard/pair?method=gaia"
                  prefetch={false}
                  className={buttonClass("primary")}
                >
                  Pair with Google account
                </Link>
                <Link
                  href="/dashboard/pair?method=qr"
                  prefetch={false}
                  className={buttonClass("secondary")}
                >
                  Pair with QR code
                </Link>
              </div>
            </div>
          );
        },
      })}
    </Card>
  );
}

async function McpCard() {
  await connection();
  const mcpUrl = Env.mcpResourceUrl();
  return (
    <Card
      title="Connect an MCP client"
      description="Add this URL as a remote MCP server. The client signs in with OAuth: it opens openrcs in your browser for you to approve access, so there are no API keys to copy."
    >
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted p-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-sm" title={mcpUrl}>
          {mcpUrl}
        </code>
        <CopyButton value={mcpUrl} />
      </div>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <div
      aria-hidden
      className="h-44 animate-pulse rounded-2xl border border-border bg-surface"
    />
  );
}

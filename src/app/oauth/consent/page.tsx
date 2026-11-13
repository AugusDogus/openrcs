import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Actions, Alert, AuthShell, buttonClass, PageTitle } from "@/app/_components/ui";
import { ConsentFlow } from "@/lib/oauth/consent";
import { OAuthContext } from "@/lib/oauth/context";
import { McpScope } from "@/lib/oauth/scopes";

export const metadata: Metadata = { title: "Authorize access", robots: { index: false } };

type SearchParams = Record<string, string | string[] | undefined>;

export default function ConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  return (
    <AuthShell>
      <div className="flex flex-col gap-6 rounded-2xl border border-border bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <Suspense fallback={<ConsentSkeleton />}>
          <ConsentContent searchParams={searchParams} />
        </Suspense>
      </div>
    </AuthShell>
  );
}

const toSearchParams = (params: SearchParams): URLSearchParams => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") result.append(key, value);
    else if (Array.isArray(value)) for (const item of value) result.append(key, item);
  }
  return result;
};

async function ConsentContent({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = toSearchParams(await searchParams);
  const requestHeaders = await headers();
  const view = await ConsentFlow.load(OAuthContext.fromEnv(), params, requestHeaders);

  switch (view.kind) {
    case "sign_in":
      return redirect(view.signInUrl);
    case "invalid":
      return <Alert tone="warning">{view.message}</Alert>;
    case "unavailable":
      return <Alert tone="danger">{view.message}</Alert>;
    case "locked":
      return (
        <>
          <PageTitle title={`Allow ${view.clientName} to use openrcs?`} />
          <Alert tone="warning">{view.message}</Alert>
          <Actions>
            <Link href="/dashboard" className={buttonClass("primary")}>
              Open openrcs
            </Link>
          </Actions>
        </>
      );
    case "ready":
      return (
        <>
          <PageTitle title={`Allow ${view.clientName} to use openrcs?`}>
            Only if you just connected it yourself. You go back to{" "}
            <span className="font-mono text-[13px] text-foreground">{view.redirectHost}</span> after.
          </PageTitle>
          <ul className="flex flex-col gap-2.5">
            {view.scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2.5 text-sm leading-6">
                <svg aria-hidden viewBox="0 0 16 16" className="mt-1 size-4 shrink-0 text-accent">
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {McpScope.describe(scope)}
              </li>
            ))}
          </ul>
          {view.createsKey ? (
            <p className="text-sm leading-6 text-muted">
              This browser becomes the one that holds your key, so pair your phone from it afterwards.
            </p>
          ) : null}
          <form method="post" action="/oauth/consent/decision">
            <input type="hidden" name="ticket" value={view.ticket} />
            <Actions>
              <button type="submit" name="decision" value="deny" className={buttonClass("secondary")}>
                Deny
              </button>
              <button type="submit" name="decision" value="approve" className={buttonClass("primary")}>
                Approve
              </button>
            </Actions>
          </form>
        </>
      );
  }
}

function ConsentSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="h-12 rounded-lg bg-surface-muted" />
      <div className="h-20 rounded-lg bg-surface-muted" />
      <div className="h-10 rounded-lg bg-surface-muted" />
    </div>
  );
}

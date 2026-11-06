import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AuthShell, buttonClass } from "@/app/_components/ui";
import { ConsentFlow } from "@/lib/oauth/consent";
import { OAuthContext } from "@/lib/oauth/context";
import { McpScope } from "@/lib/oauth/scopes";

export const metadata: Metadata = { title: "Authorize access", robots: { index: false } };

type SearchParams = Record<string, string | string[] | undefined>;

export default function ConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  return (
    <AuthShell title="Authorize access">
      <Suspense fallback={<ConsentSkeleton />}>
        <ConsentContent searchParams={searchParams} />
      </Suspense>
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
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6">
            <span className="font-semibold">{view.clientName}</span> wants to access your openrcs
            account.
          </p>
          <Alert tone="warning">{view.message}</Alert>
          <Link href="/dashboard" className={buttonClass("secondary", "w-full")}>
            Go to the dashboard
          </Link>
        </div>
      );
    case "ready":
      return (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-sm leading-6">
              <span className="font-semibold">{view.clientName}</span> wants to access your
              openrcs account.
            </p>
            <p className="text-xs text-muted">
              You will be sent back to <span className="font-mono">{view.redirectHost}</span>. Only
              approve if you started this from an app you trust.
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              It will be able to
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {view.scopes.map((scope) => (
                <li key={scope} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    {McpScope.describe(scope)}{" "}
                    <span className="font-mono text-xs text-muted">{scope}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {view.createsKey ? (
            <p className="text-xs leading-5 text-muted">
              Approving also makes this browser the one that holds your account key: pair your
              phone from this browser afterwards. MCP clients approved from another browser
              before pairing will be disconnected.
            </p>
          ) : null}
          <form
            method="post"
            action="/oauth/consent/decision"
            className="flex flex-col-reverse gap-2 sm:flex-row"
          >
            <input type="hidden" name="ticket" value={view.ticket} />
            <button
              type="submit"
              name="decision"
              value="deny"
              className={buttonClass("secondary", "sm:flex-1")}
            >
              Deny
            </button>
            <button
              type="submit"
              name="decision"
              value="approve"
              className={buttonClass("primary", "sm:flex-1")}
            >
              Approve
            </button>
          </form>
        </div>
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

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { Result } from "better-result";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AuthFormSkeleton } from "@/app/_components/auth-forms";
import { Alert, AuthShell, buttonClass } from "@/app/_components/ui";
import { getCurrentUser } from "@/app/_lib/session";
import { getAuth } from "@/lib/auth";
import { ConsentDecision } from "./consent-decision";

export const metadata: Metadata = { title: "Authorize access" };

type SearchParams = Record<string, string | string[] | undefined>;

export default function ConsentPage({ searchParams }: PageProps<"/consent">) {
  return (
    <AuthShell title="Authorize access">
      <Suspense fallback={<AuthFormSkeleton />}>
        <ConsentContent searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without asking you again",
  "messages:read": "Read your conversations and messages",
  "messages:send": "Send messages from your phone",
};

const toSearchParams = (params: SearchParams): URLSearchParams => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") result.append(key, value);
    else if (Array.isArray(value)) for (const item of value) result.append(key, item);
  }
  return result;
};

/** Keeps only the signed parameters and checks the provider's signature and expiry. */
const verifySignedQuery = async (params: URLSearchParams): Promise<URLSearchParams | null> => {
  const signed = new Set(["sig", "ba_param", ...params.getAll("ba_param")]);
  const query = new URLSearchParams([...params].filter(([key]) => signed.has(key)));
  if (!query.has("sig")) return null;
  const { secret } = await getAuth().$context;
  return (await verifyOAuthQueryParams(query.toString(), secret)) ? query : null;
};

const hostOf = (uri: string | null): string | null => {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.host || `${url.protocol}//`;
  } catch {
    return null;
  }
};

function RestartMessage({ children }: { children: ReactNode }) {
  return (
    <Alert tone="warning">
      {children} Nothing was shared. Return to your MCP client and start the connection again.
    </Alert>
  );
}

async function ConsentContent({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = toSearchParams(await searchParams);
  const query = await verifySignedQuery(params);
  if (!query) {
    return <RestartMessage>This authorization request is invalid or has expired.</RestartMessage>;
  }

  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-6 text-muted">Sign in to review this request.</p>
        <Link href={`/sign-in?${params.toString()}`} className={buttonClass("primary", "w-full")}>
          Sign in
        </Link>
      </div>
    );
  }

  const clientId = query.get("client_id");
  if (!clientId) {
    return <RestartMessage>This authorization request does not name a client.</RestartMessage>;
  }
  const requestHeaders = await headers();
  const client = await Result.tryPromise(() =>
    getAuth().api.getOAuthClientPublic({ query: { client_id: clientId }, headers: requestHeaders }),
  );
  if (client.isErr()) {
    return <RestartMessage>The application requesting access is unknown or disabled.</RestartMessage>;
  }

  const clientName = client.value.client_name?.trim() || "An unnamed application";
  const redirectHost = hostOf(query.get("redirect_uri"));
  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm leading-6">
          <span className="font-semibold">{clientName}</span> wants to access your openrcs
          account <span className="text-muted">({user.email})</span>.
        </p>
        {redirectHost ? (
          <p className="text-xs text-muted">
            You will be sent back to <span className="font-mono">{redirectHost}</span>. Only
            approve if you started this from an app you trust.
          </p>
        ) : null}
      </div>
      {scopes.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            It will be able to
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2 text-sm">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                <span>
                  {SCOPE_DESCRIPTIONS[scope] ?? scope}{" "}
                  <span className="font-mono text-xs text-muted">{scope}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ConsentDecision />
    </div>
  );
}

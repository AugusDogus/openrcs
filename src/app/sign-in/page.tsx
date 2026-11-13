import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AuthShell } from "@/app/_components/ui";
import { getCurrentUser } from "@/app/_lib/session";
import { TailscaleIdentity } from "@/lib/auth-tailscale";
import { Env } from "@/lib/env";
import { CallbackUrl } from "./callback-url";
import { GitHubSignInButton } from "./github-sign-in-button";
import { TailscaleSignIn } from "./tailscale-sign-in";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthShell title="Sign in" subtitle="Sign in to openrcs.">
      <Suspense fallback={<div aria-hidden className="h-10 rounded-lg bg-surface-muted" />}>
        <SignInContent searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function SignInContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackURL = CallbackUrl.parse(first(params.callbackURL));
  // Already signed in (e.g. resuming an MCP authorization): continue right away.
  if (await getCurrentUser()) redirect(callbackURL);
  if (Env.auth().AUTH_PROVIDER === "tailscale") {
    const identity = TailscaleIdentity.fromHeaders(await headers());
    return identity ? (
      <TailscaleSignIn login={identity.login} callbackURL={callbackURL} />
    ) : (
      <Alert tone="warning">
        This request carried no Tailscale identity, so openrcs cannot tell who you are. Open openrcs at its
        Tailscale Serve address (https://&lt;name&gt;.&lt;tailnet&gt;.ts.net) from a device signed in to your
        tailnet as a user. Tagged devices and Funnel visitors have no identity.
      </Alert>
    );
  }
  const failed = first(params.error) !== undefined;
  return (
    <div className="flex flex-col gap-4">
      {failed ? (
        <Alert tone="danger">
          GitHub sign-in did not complete. Nothing was changed; try again.
        </Alert>
      ) : null}
      <GitHubSignInButton callbackURL={callbackURL} />
    </div>
  );
}

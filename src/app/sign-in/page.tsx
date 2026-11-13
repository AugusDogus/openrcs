import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AuthShell } from "@/app/_components/ui";
import { getCurrentUser } from "@/app/_lib/session";
import { TailscaleIdentity } from "@/lib/auth-tailscale";
import { CallbackUrl } from "./callback-url";
import { TailscaleSignIn } from "./tailscale-sign-in";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthShell>
      <Suspense fallback={<div aria-hidden className="h-9" />}>
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
  const identity = TailscaleIdentity.fromHeaders(await headers());
  return identity ? (
    <TailscaleSignIn login={identity.login} callbackURL={callbackURL} />
  ) : (
    <Alert tone="warning">
      openrcs could not tell who you are. Open it at its https://…ts.net address from a device signed in to your
      tailnet as a person (tagged devices have no identity).
    </Alert>
  );
}

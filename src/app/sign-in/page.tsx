import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AuthShell } from "@/app/_components/ui";
import { getCurrentUser } from "@/app/_lib/session";
import { CallbackUrl } from "./callback-url";
import { GitHubSignInButton } from "./github-sign-in-button";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthShell title="Sign in" subtitle="Sign in to openrcs with your GitHub account.">
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

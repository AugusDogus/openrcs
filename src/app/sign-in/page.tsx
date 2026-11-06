import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthFormSkeleton, SignInForm } from "@/app/_components/auth-forms";
import { AuthShell } from "@/app/_components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthShell title="Sign in" subtitle="Use your openrcs account to continue.">
      <Suspense fallback={<AuthFormSkeleton />}>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthFormSkeleton, SignUpForm } from "@/app/_components/auth-forms";
import { AuthShell } from "@/app/_components/ui";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="openrcs is invite-only: use the email address you were invited with."
    >
      <Suspense fallback={<AuthFormSkeleton />}>
        <SignUpForm />
      </Suspense>
    </AuthShell>
  );
}

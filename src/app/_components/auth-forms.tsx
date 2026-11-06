"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Alert, buttonClass, Field } from "./ui";

// Mirrors EMAIL_NOT_ALLOWED_CODE in src/lib/auth.ts (not imported: server-only module).
const EMAIL_NOT_ALLOWED_CODE = "EMAIL_NOT_ALLOWED";

type FormError =
  | { readonly kind: "not-allowed" }
  | { readonly kind: "message"; readonly message: string };

type AuthClientError = { code?: string; message?: string; status: number };

const toFormError = (error: AuthClientError, fallback: string): FormError => {
  if (error.code === EMAIL_NOT_ALLOWED_CODE) return { kind: "not-allowed" };
  if (error.status === 429) {
    return { kind: "message", message: "Too many attempts. Wait a minute and try again." };
  }
  return { kind: "message", message: error.message || fallback };
};

function FormErrorAlert({ error }: { error: FormError | null }) {
  if (!error) return null;
  if (error.kind === "not-allowed") {
    return (
      <Alert tone="warning">
        <p className="font-medium">This email isn&apos;t on the invite list.</p>
        <p className="mt-1">
          openrcs is invite-only. Ask the person who runs this instance to add your address,
          or sign up with the address you were invited with.
        </p>
      </Alert>
    );
  }
  return <Alert tone="danger">{error.message}</Alert>;
}

const readField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Keeps the signed OAuth query when moving between sign-in and sign-up mid-authorization. */
const useLinkWithQuery = (path: string): string => {
  const query = useSearchParams().toString();
  return query ? `${path}?${query}` : path;
};

export function SignInForm() {
  const router = useRouter();
  const signUpHref = useLinkWithQuery("/sign-up");
  const [error, setError] = useState<FormError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: signInError } = await authClient.signIn.email({
      email: readField(form, "email"),
      password: readField(form, "password"),
    });
    if (signInError) {
      setError(toFormError(signInError, "Could not sign in. Check your email and password."));
      setPending(false);
      return;
    }
    // During an MCP authorization the response redirects to the client; the
    // auth client follows it.
    if (data?.redirect) return;
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Email" id="email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <FormErrorAlert error={error} />
      <button type="submit" disabled={pending} className={buttonClass("primary", "mt-1 w-full")}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-muted">
        New here?{" "}
        <Link href={signUpHref} className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const signInHref = useLinkWithQuery("/sign-in");
  const [error, setError] = useState<FormError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: signUpError } = await authClient.signUp.email({
      name: readField(form, "name"),
      email: readField(form, "email"),
      password: readField(form, "password"),
    });
    if (signUpError) {
      setError(toFormError(signUpError, "Could not create your account. Try again."));
      setPending(false);
      return;
    }
    if (data && "redirect" in data && data.redirect === true) return;
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="Name" id="name" name="name" autoComplete="name" required />
      <Field label="Email" id="email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormErrorAlert error={error} />
      <button type="submit" disabled={pending} className={buttonClass("primary", "mt-1 w-full")}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href={signInHref} className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function AuthFormSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="h-[62px] rounded-lg bg-surface-muted" />
      <div className="h-[62px] rounded-lg bg-surface-muted" />
      <div className="h-10 rounded-lg bg-surface-muted" />
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonBase =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-foreground hover:bg-surface-muted",
  ghost: "text-muted hover:bg-surface-muted hover:text-foreground",
  danger: "bg-danger text-white hover:opacity-90",
};

export const buttonClass = (variant: ButtonVariant = "primary", extra = "") =>
  `${buttonBase} ${buttonVariants[variant]} ${extra}`.trim();

/** The openrcs mark: a speech bubble shaped like an "o". Same artwork as src/app/icon.svg. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="9" fill="#2c6a59" />
      <path
        d="M16.5 6.5a9.5 9.5 0 1 1-4.37 17.94l-4.02 1.45c-.8.29-1.57-.48-1.28-1.28l1.45-4.02A9.5 9.5 0 0 1 16.5 6.5Zm0 4.6a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8Z"
        fill="#fff"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
      <LogoMark />
      openrcs
    </span>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`${className} inline-block shrink-0 animate-spin rounded-full border-2 border-border border-t-accent [animation-duration:600ms]`}
    />
  );
}

type AlertTone = "danger" | "warning" | "success";

const alertTones: Record<AlertTone, string> = {
  danger: "bg-danger-surface text-danger",
  warning: "bg-warning-surface text-warning",
  success: "bg-success-surface text-success",
};

export function Alert({ tone, children }: { tone: AlertTone; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg px-3.5 py-3 text-sm leading-6 ${alertTones[tone]}`}>
      {children}
    </div>
  );
}

/** Signed-in pages: the logo (home) on the left, who you are on the right, one column of content. */
export function AppShell({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between gap-4 px-5">
        <Link href="/dashboard" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Logo />
        </Link>
        {aside}
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-12 px-5 pt-6 pb-16">{children}</main>
    </div>
  );
}

/** A titled part of a page. No box: the content's own rows and fields carry the structure. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Page heading with an optional one-line explanation. */
export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      {children ? <p className="text-sm leading-6 text-muted text-pretty">{children}</p> : null}
    </div>
  );
}

/** Right-aligned action row, main action last (stacked, main on top, on phones). */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">{children}</div>;
}

/** Centered single panel for pages outside the app (sign-in, authorizing an agent). */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-5 py-12">
      <Logo />
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

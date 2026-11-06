import type { ComponentProps, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";

const buttonBase =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-foreground hover:bg-surface-muted",
  ghost: "text-muted hover:bg-surface-muted hover:text-foreground",
};

export const buttonClass = (variant: ButtonVariant = "primary", extra = "") =>
  `${buttonBase} ${buttonVariants[variant]} ${extra}`.trim();

export function Card({
  title,
  description,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${className}`}
    >
      {title ? <h2 className="text-base font-semibold tracking-tight">{title}</h2> : null}
      {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
      <div className={title || description ? "mt-5" : ""}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  id,
  ...input
}: { label: string; id: string } & ComponentProps<"input">) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        id={id}
        className="h-10 rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
        {...input}
      />
    </label>
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

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-lg bg-accent text-[13px] font-bold text-accent-foreground"
      >
        r
      </span>
      openrcs
    </span>
  );
}

/** Centered single-column layout for sign-in, sign-up and consent. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm leading-6 text-muted">{subtitle}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}

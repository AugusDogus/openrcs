/**
 * Runs once per server process (Next.js instrumentation): starts the
 * background sync of paired phones (src/lib/rcs/background-sync.ts). Node.js
 * runtime only, and never during `next build`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { BackgroundSync } = await import("@/lib/rcs/background-sync");
  BackgroundSync.startFromEnv();
}

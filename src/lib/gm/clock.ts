// Time source and timers used by the protocol layer, injectable so tests can
// shorten waits and check that nothing is left scheduled after close().

export type TimerHandle = ReturnType<typeof setTimeout>;

export type Clock = {
  now(): Date;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type SleepOutcome = "slept" | "aborted";

export const Clock = {
  real: {
    now: () => new Date(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: TimerHandle) => clearTimeout(handle),
  } satisfies Clock,

  /** Resolves after `ms`, or early with "aborted" when `signal` fires. Never rejects. */
  sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<SleepOutcome> {
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clock.clearTimeout(handle);
        resolve("aborted");
      };
      const handle = clock.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve("slept");
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
} as const;

import { Clock, type TimerHandle } from "../clock";

/** Real-time clock that counts timers still scheduled, so tests can assert none dangle after close(). */
export type CountingClock = Clock & { readonly pending: () => number };

export const CountingClock = {
  create(): CountingClock {
    const live = new Set<TimerHandle>();
    return {
      now: () => new Date(),
      setTimeout(fn, ms) {
        const handle = Clock.real.setTimeout(() => {
          live.delete(handle);
          fn();
        }, ms);
        live.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        live.delete(handle);
        Clock.real.clearTimeout(handle);
      },
      pending: () => live.size,
    };
  },
} as const;

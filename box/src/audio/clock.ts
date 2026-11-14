// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/clock.ts.

/** Time, injected so tests drive timers with a fake clock and never sleep. */
export type Cancel = () => void;

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): Cancel;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

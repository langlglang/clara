// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/clock.ts. Adds a manual clock for tests.
/**
 * Time, injected everywhere so tests drive it with a fake clock and never sleep. `now()` is wall time, used
 * only for timestamps the server reads. `monotonic()` never jumps backwards, so countdowns and deadlines use it.
 */
export type Cancel = () => void;

export interface Clock {
  now(): number;
  monotonic(): number;
  setTimeout(fn: () => void, ms: number): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class DeadlineError extends Error {
  override name = "DeadlineError";
}

/** The reason a caller aborts work on purpose (a Talk press cancelling a turn, or shutdown). */
export class CancelledError extends Error {
  override name = "CancelledError";
}

/**
 * Runs `work` with a signal that aborts after `ms` on `clock`, or when `outer` aborts. Rejects at the deadline
 * even if `work` ignores its signal.
 */
export async function withDeadline<T>(clock: Clock, ms: number, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancelTimer = clock.setTimeout(() => controller.abort(new DeadlineError(`No answer within ${ms} ms.`)), ms);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuter, { once: true });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    cancelTimer();
    outer?.removeEventListener("abort", onOuter);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    aborted.catch(() => {});
  }
}

/** A clock that only moves when a test calls `advance`. */
export class ManualClock implements Clock {
  private mono = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;

  constructor(private wall = 1_700_000_000_000) {}

  now(): number {
    return this.wall;
  }

  monotonic(): number {
    return this.mono;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    const id = this.nextId++;
    this.timers.push({ at: this.mono + Math.max(0, ms), fn, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  /** Moves time forward, firing due timers in order (timers they set fire too if due). */
  advance(ms: number): void {
    const end = this.mono + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.wall += due.at - this.mono;
      this.mono = due.at;
      due.fn();
    }
    this.wall += end - this.mono;
    this.mono = end;
  }

  pending(): number {
    return this.timers.length;
  }
}

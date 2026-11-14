import type { Board, BoardEvent } from "../ports.js";

/** A result from the connected ESP32, never from a cached or simulated reading. */
export interface PulseObservation {
  bpm: number | null;
  quality: "valid" | "suspect" | "unavailable";
  observedAt: string;
  source: "MAX30102 via ESP32";
  sequence: number;
}

const isPulse = (event: BoardEvent): event is Extract<BoardEvent, { t: "pulse" }> => "t" in event && event.t === "pulse";

/** One requested measurement window. The firmware needs several consistent beats before it can return BPM. */
export class PulseReader {
  private active: ((event: BoardEvent) => void) | null = null;

  constructor(private readonly board: Pick<Board, "simulated" | "onEvent" | "startPulse" | "stopPulse">) {
    board.onEvent((event) => this.active?.(event));
  }

  async read(signal: AbortSignal, timeoutMs = 20_000): Promise<PulseObservation | null> {
    if (this.board.simulated || this.active || signal.aborted || timeoutMs <= 0) return null;
    let accepting = false;
    let unavailableCount = 0;
    let latest: PulseObservation | null = null;
    let finish!: (value: PulseObservation | null) => void;
    const result = new Promise<PulseObservation | null>((resolve) => { finish = resolve; });
    this.active = (event) => {
      if ("type" in event && event.type === "disconnected") return finish(null);
      if (!accepting || !isPulse(event)) return;
      const valid = event.quality === "valid" && event.bpm !== null;
      latest = {
        bpm: valid ? event.bpm : null,
        quality: valid ? "valid" : event.quality === "suspect" ? "suspect" : "unavailable",
        observedAt: new Date().toISOString(),
        source: "MAX30102 via ESP32",
        sequence: event.seq,
      };
      if (valid || (event.quality === "unavailable" && ++unavailableCount >= 2)) finish(latest);
    };
    const timer = setTimeout(() => finish(latest), Math.min(timeoutMs, 20_000));
    const cancel = () => finish(null);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!(await this.board.startPulse()) || signal.aborted) return null;
      accepting = true;
      return await result;
    } finally {
      accepting = false;
      this.active = null;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      await this.board.stopPulse().catch(() => false);
    }
  }
}

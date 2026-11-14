import type { Board, BoardEvent } from "../ports.js";
import { EventHub } from "./event-hub.js";
import { createLogger, type Logger } from "./log.js";

/**
 * An in-memory ESP32 for the simulator and tests. Drive it from code (`setLid`, `setMount`, `setPulse`) or the
 * keyboard (`attachKeyboard`); every LED, rhythm and buzzer command is logged and kept in `history`.
 *
 * It follows the firmware's rules so the box behaves the same against it: one compartment lit at a time, a light
 * goes off when its lease ends or the lid closes, rhythm and buzzer stop on lid close, and a pulse reading is a
 * number only when its quality is `valid` (the default reading is `unavailable` with no number).
 */
export type SimCommand =
  | { t: "led"; ch: number; ms: number; mode: "solid" | "blink" | "pulse" }
  | { t: "rhythm"; bpm: number }
  | { t: "buzz"; pattern: "chime" | "alert" | "off" }
  | { t: "pulse.start" }
  | { t: "pulse.stop" };

export interface SimBoardOptions {
  leds?: number;
  firmware?: string;
  lidOpen?: boolean;
  onWall?: boolean;
  log?: Logger;
  /** How often readings are sent while the pulse sensor runs (the firmware sends one a second). */
  pulseIntervalMs?: number;
  /** Simulate a board that refuses LED commands while the lid is closed, like the firmware. */
  requireLidOpenForLeds?: boolean;
}

type PulseQuality = "valid" | "suspect" | "unavailable";

export class SimBoard implements Board {
  readonly label = "simulated board";
  readonly simulated = true;
  readonly leds: number;
  /** Every command the box sent, in order. */
  readonly history: SimCommand[] = [];
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly firmware: string;
  private readonly pulseIntervalMs: number;
  private readonly requireLidOpen: boolean;
  private seq = 0;
  private lid: boolean;
  private wall: boolean;
  private lit: { ch: number; mode: string; until: number } | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private rhythmBpm = 0;
  private pulseTimer: NodeJS.Timeout | null = null;
  private reading: { bpm: number | null; quality: PulseQuality } = { bpm: null, quality: "unavailable" };
  private open = true;

  constructor(options: SimBoardOptions = {}) {
    this.leds = options.leds ?? 6;
    this.firmware = options.firmware ?? "sim-0.1.0";
    this.lid = options.lidOpen ?? false;
    this.wall = options.onWall ?? true;
    this.log = options.log ?? createLogger("sim-board");
    this.pulseIntervalMs = options.pulseIntervalMs ?? 1000;
    this.requireLidOpen = options.requireLidOpenForLeds ?? false;
    this.hub = new EventHub(this.log);
    this.hub.emit({ type: "connected", firmware: this.firmware, leds: this.leds });
    this.hub.emit({ t: "lid", open: this.lid, seq: this.seq++ });
    this.hub.emit({ t: "mount", on_wall: this.wall, seq: this.seq++ });
  }

  // ---- driving the simulated hardware ----

  setLid(open: boolean): void {
    if (!this.open || open === this.lid) return;
    this.lid = open;
    this.log.info(open ? "lid opened" : "lid closed");
    if (!open) this.quiet("lid closed");
    this.hub.emit({ t: "lid", open, seq: this.seq++ });
  }

  setMount(onWall: boolean): void {
    if (!this.open || onWall === this.wall) return;
    this.wall = onWall;
    this.log.info(onWall ? "back on the wall mount" : "lifted off the wall mount");
    this.hub.emit({ t: "mount", on_wall: onWall, seq: this.seq++ });
  }

  /**
   * The reading the simulated sensor reports from now on. A number is kept only with `valid` quality: the
   * board never reports a bpm it doesn't trust, and neither does the simulator.
   */
  setPulse(bpm: number | null, quality: PulseQuality = bpm === null ? "unavailable" : "valid"): void {
    const valid = quality === "valid" && bpm !== null && Number.isInteger(bpm) && bpm >= 0 && bpm <= 250;
    this.reading = { bpm: valid ? bpm : null, quality: valid ? "valid" : quality === "valid" ? "unavailable" : quality };
  }

  /** Simulates the USB cable being pulled (and `reconnect` plugging it back). */
  disconnect(reason = "simulated unplug"): void {
    this.quiet(reason);
    this.stopPulseTimer();
    this.hub.emit({ type: "disconnected", reason });
  }

  reconnect(): void {
    this.seq = 0;
    this.hub.emit({ type: "connected", firmware: this.firmware, leds: this.leds });
    this.hub.emit({ t: "lid", open: this.lid, seq: this.seq++ });
    this.hub.emit({ t: "mount", on_wall: this.wall, seq: this.seq++ });
  }

  get lidOpen(): boolean {
    return this.lid;
  }

  get onWall(): boolean {
    return this.wall;
  }

  /** The lit compartment, or null. */
  get litChannel(): number | null {
    return this.lit?.ch ?? null;
  }

  get rhythmRunning(): number {
    return this.rhythmBpm;
  }

  get pulseRunning(): boolean {
    return this.pulseTimer !== null;
  }

  // ---- Board ----

  onEvent(listener: (event: BoardEvent) => void): void {
    this.hub.on(listener);
  }

  async lightCompartment(channel: number, ms: number, mode: "solid" | "blink" | "pulse" = "solid"): Promise<boolean> {
    if (!this.accepting()) return false;
    const ok = Number.isInteger(channel) && channel >= 0 && channel < this.leds && ms >= 0 && ms <= 60_000;
    if (!ok) {
      this.log.warn("LED command refused", { channel, ms });
      return false;
    }
    if (this.requireLidOpen && !this.lid) {
      this.log.warn("LED command refused: lid closed", { channel });
      return false;
    }
    this.history.push({ t: "led", ch: channel, ms, mode });
    this.setLight(channel, ms, mode);
    return true;
  }

  async clearLights(): Promise<boolean> {
    if (!this.accepting()) return false;
    this.history.push({ t: "led", ch: -1, ms: 0, mode: "solid" });
    this.clearLight("cleared");
    return true;
  }

  async rhythm(bpm: number): Promise<boolean> {
    if (!this.accepting() || !Number.isInteger(bpm) || bpm < 0 || bpm > 200) return false;
    this.history.push({ t: "rhythm", bpm });
    this.rhythmBpm = bpm;
    this.log.info(bpm === 0 ? "rhythm stopped" : `all LEDs: rhythm at ${bpm} bpm`);
    return true;
  }

  async buzz(pattern: "chime" | "alert" | "off"): Promise<boolean> {
    if (!this.accepting()) return false;
    this.history.push({ t: "buzz", pattern });
    this.log.info(pattern === "off" ? "buzzer off" : `buzzer: ${pattern}`);
    return true;
  }

  async startPulse(): Promise<boolean> {
    if (!this.accepting()) return false;
    this.history.push({ t: "pulse.start" });
    if (!this.pulseTimer) {
      this.pulseTimer = setInterval(() => {
        this.hub.emit({ t: "pulse", bpm: this.reading.bpm, quality: this.reading.quality, seq: this.seq++ });
      }, this.pulseIntervalMs);
    }
    this.log.info("pulse sensor started");
    return true;
  }

  async stopPulse(): Promise<boolean> {
    if (!this.accepting()) return false;
    this.history.push({ t: "pulse.stop" });
    this.stopPulseTimer();
    this.log.info("pulse sensor stopped");
    return true;
  }

  async close(): Promise<void> {
    this.quiet("closed");
    this.stopPulseTimer();
    this.open = false;
  }

  // ---- inside ----

  private accepting(): boolean {
    return this.open && this.hub.connected;
  }

  private setLight(ch: number, ms: number, mode: string): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.lit = { ch, mode, until: Date.now() + ms };
    this.log.info(`LED ${ch} on (${mode}) for ${ms} ms; others off`);
    this.leaseTimer = setTimeout(() => this.clearLight("lease ended"), ms);
  }

  private clearLight(why: string): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    if (this.lit) this.log.info(`LED ${this.lit.ch} off (${why})`);
    this.lit = null;
  }

  /** What the firmware does on lid close, disconnect and reset: lights, rhythm and buzzer off. */
  private quiet(why: string): void {
    this.clearLight(why);
    this.rhythmBpm = 0;
  }

  private stopPulseTimer(): void {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.pulseTimer = null;
  }
}

/** Keys the simulator listens for (`attachKeyboard`). */
export const SIM_KEYS = "o: open/close the lid · w: lift off/put back on the wall mount · p: cycle the pulse reading (none → 72 valid → suspect) · u: unplug/replug · ?: help";

/**
 * Drives a SimBoard from single key presses on a TTY. Returns a function that detaches it. Does nothing
 * (and returns a no-op) when `input` isn't a TTY, so a service under systemd never grabs stdin.
 */
export function attachKeyboard(board: SimBoard, input: NodeJS.ReadStream = process.stdin, log: Logger = createLogger("sim-board")): () => void {
  if (!input.isTTY) return () => {};
  const pulses: Array<[number | null, PulseQuality]> = [
    [null, "unavailable"],
    [72, "valid"],
    [null, "suspect"],
  ];
  let pulseIndex = 0;
  let unplugged = false;
  const onData = (data: Buffer | string) => {
    for (const key of data.toString()) {
      switch (key) {
        case "o":
          board.setLid(!board.lidOpen);
          break;
        case "w":
          board.setMount(!board.onWall);
          break;
        case "p": {
          pulseIndex = (pulseIndex + 1) % pulses.length;
          const [bpm, quality] = pulses[pulseIndex]!;
          board.setPulse(bpm, quality);
          log.info(`simulated pulse reading: ${bpm ?? "no number"} (${quality})`);
          break;
        }
        case "u":
          unplugged = !unplugged;
          if (unplugged) board.disconnect();
          else board.reconnect();
          break;
        case "?":
          log.info(SIM_KEYS);
          break;
        case "\u0003": // Ctrl+C: raw mode swallows the signal, so send it ourselves.
          detach();
          process.kill(process.pid, "SIGINT");
          return;
        default:
          break;
      }
    }
  };
  const detach = () => {
    input.off("data", onData);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  };
  input.setRawMode(true);
  input.resume();
  input.on("data", onData);
  log.info(`simulated board keys: ${SIM_KEYS}`);
  return detach;
}

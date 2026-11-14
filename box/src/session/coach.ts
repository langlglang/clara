import { CLIP_SAMPLE_RATE } from "../audio/constants.js";
import { wavFromPcm } from "../audio/wav.js";
import type { Board, SpeechQueue, Utterance } from "../ports.js";
import type { Cancel, Clock } from "./clock.js";

/**
 * The CPR rhythm coach. While a scenario step with `coach: { kind: "cpr", bpm }` is shown it:
 * - runs the board's LED beat (`rhythm(bpm, "beat")`);
 * - plays a generated metronome tick (a tone, never TTS). Ticks are rendered into one WAV segment that runs up to
 *   the next spoken prompt, aligned to a beat grid fixed at the start, so their spacing is sample-exact rather than
 *   one timer per tick. Whenever the speech queue speaks a line the segment stops, and it resumes on the same grid
 *   when the line ends;
 * - says a short fixed prompt every PROMPT_EVERY_MS.
 * The compression counter on screen is derived from `started_at` and `bpm`, so the view is not republished per beat.
 */

export const CPR_PROMPT = "Push hard and fast. Keep going.";
export const PROMPT_EVERY_MS = 20_000;
const TICK_HZ = 1_200;
const TICK_MS = 35;
const TICK_VOLUME = 0.3;

export interface CoachOptions {
  clock: Clock;
  board?: Board | null;
  speech?: SpeechQueue | null;
  /** Plays a WAV straight to the speaker (outside the speech queue). Null: LED and screen only. */
  play?: ((wav: Buffer) => Utterance) | null;
  log?: (line: string) => void;
}

interface Run {
  bpm: number;
  stepId: string;
  /** Monotonic ms of beat 0. */
  t0: number;
  /** Wall-clock ms of beat 0 (for the screen). */
  startedAt: number;
  segment: Utterance | null;
  cancelPrompt: Cancel;
}

export class RhythmCoach {
  private run: Run | null = null;
  /** For tests and logs: tick segments started. */
  segments = 0;
  prompts = 0;

  constructor(private readonly o: CoachOptions) {
    o.speech?.onBusy(() => this.pauseTicks());
    o.speech?.onIdle(() => this.resumeTicks());
  }

  get active(): { bpm: number; step_id: string; started_at: number } | null {
    return this.run ? { bpm: this.run.bpm, step_id: this.run.stepId, started_at: this.run.startedAt } : null;
  }

  /** Beats since the start, counting the first: the compression count the screen shows. */
  beats(): number {
    const run = this.run;
    if (!run) return 0;
    return Math.floor((this.o.clock.monotonic() - run.t0) / (60_000 / run.bpm)) + 1;
  }

  /** Starts coaching for a step; the same step again keeps the running beat. */
  start(stepId: string, bpm: number): void {
    // The next coached step at the same rate keeps the beat (and the count) going.
    if (this.run && this.run.bpm === bpm) {
      this.run.stepId = stepId;
      return;
    }
    this.stop();
    const run: Run = { bpm, stepId, t0: this.o.clock.monotonic(), startedAt: this.o.clock.now(), segment: null, cancelPrompt: () => {} };
    this.run = run;
    this.boardCall((b) => b.rhythm(bpm, "beat"));
    this.o.log?.(`coach: CPR rhythm ${bpm} bpm`);
    this.schedulePrompt(run);
    this.resumeTicks();
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.cancelPrompt();
    run.segment?.stop();
    run.segment = null;
    this.boardCall((b) => b.rhythm(0));
    this.o.log?.("coach: rhythm stopped");
  }

  private schedulePrompt(run: Run): void {
    const elapsed = this.o.clock.monotonic() - run.t0;
    const wait = PROMPT_EVERY_MS - (elapsed % PROMPT_EVERY_MS);
    run.cancelPrompt = this.o.clock.setTimeout(() => {
      if (this.run !== run) return;
      this.prompts += 1;
      this.pauseTicks();
      this.o.speech?.say({ text: CPR_PROMPT }).catch(() => {});
      this.schedulePrompt(run);
      // Without a speech queue nothing will call resumeTicks: start the next segment now.
      if (!this.o.speech) this.resumeTicks();
    }, wait);
  }

  private pauseTicks(): void {
    const run = this.run;
    if (!run?.segment) return;
    run.segment.stop();
    run.segment = null;
  }

  private resumeTicks(): void {
    const run = this.run;
    if (!run || run.segment || !this.o.play) return;
    if (this.o.speech?.busy || this.o.speech?.muted) return;
    const now = this.o.clock.monotonic();
    const interval = 60_000 / run.bpm;
    const elapsed = now - run.t0;
    const nextBeat = run.t0 + Math.ceil(elapsed / interval) * interval;
    const nextPrompt = run.t0 + (Math.floor(elapsed / PROMPT_EVERY_MS) + 1) * PROMPT_EVERY_MS;
    const wav = tickSegment(nextBeat - now, interval, nextPrompt - nextBeat);
    if (!wav) return;
    this.segments += 1;
    try {
      const segment = this.o.play(wav);
      run.segment = segment;
      segment.done.then(() => {
        if (this.run === run && run.segment === segment) run.segment = null;
      }, () => {
        if (this.run === run && run.segment === segment) run.segment = null;
      });
    } catch (error) {
      this.o.log?.(`coach: tick failed (${(error as Error).message})`);
    }
  }

  private boardCall(call: (board: Board) => Promise<unknown>): void {
    const board = this.o.board;
    if (!board) return;
    try {
      call(board).catch((error: unknown) => this.o.log?.(`board: ${(error as Error)?.message ?? "failed"}`));
    } catch (error) {
      this.o.log?.(`board: ${(error as Error)?.message ?? "failed"}`);
    }
  }
}

/**
 * Lead-in silence, then a tick on every beat that starts before `spanMs` ends. Null when no beat fits. Each beat
 * is placed from its exact time (not by adding rounded lengths), so the grid does not drift.
 */
export function tickSegment(leadMs: number, intervalMs: number, spanMs: number): Buffer | null {
  const count = Math.max(0, Math.ceil(spanMs / intervalMs));
  if (count === 0) return null;
  const rate = CLIP_SAMPLE_RATE;
  const toSample = (ms: number) => Math.round((ms / 1000) * rate);
  const tick = toSample(TICK_MS);
  const fade = Math.max(1, toSample(5));
  const total = toSample(leadMs + (count - 1) * intervalMs) + tick;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < count; i++) {
    const start = toSample(leadMs + i * intervalMs);
    for (let j = 0; j < tick && start + j < total; j++) {
      const envelope = Math.min(1, j / fade, (tick - 1 - j) / fade);
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * TICK_HZ * j) / rate) * envelope * TICK_VOLUME * 32767), (start + j) * 2);
    }
  }
  return wavFromPcm(pcm, rate);
}

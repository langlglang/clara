/**
 * The box's side of a voice turn. Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/service.ts
 * (turn deadline, fixed local lines, half-duplex), and Clara's pre-event scaffold (box/src/conversation.ts).
 *
 * Half-duplex: the listener is paused from the moment a clip is taken until the answer has finished playing,
 * and whenever the speech queue is busy. Every turn has a deadline; a timeout or no link ends in a
 * fixed local line, while the current visual and mock SOS remain available.
 */
import { randomUUID } from "node:crypto";
import {
  TurnResponseSchema,
  VOICE_TURN_VERSION,
  actionAllowed,
  type Action,
  type TurnInput,
  type TurnRequest,
  type TurnResponse,
  type TurnState,
} from "@clara/contracts";
import { systemClock, type Clock } from "../audio/clock.js";
import { CLIP_MAX_MS } from "../audio/constants.js";
import { silentLogger, type Logger } from "../audio/log.js";
import type { CloudLink, Clip, CueName, Listener, SpeechQueue } from "../ports.js";

/** docs/voice.md: the server's turn budget is 6 s; the box gives up at 8 s. */
export const VOICE_TURN_DEADLINE_MS = 8_000;
/** Placeholder: the listening cue's player gets this long before the mic opens anyway. */
export const LISTENING_CUE_MAX_MS = 1_000;

/** Fixed local lines (English until other languages are recorded). */
export const LOCAL_LINES = {
  timeout: "That took too long. Please tell me again.",
  unreachable: "I can't reach the assistant right now. The simulated SOS button is available.",
  notCaught: "I didn't catch that. Please tell me again.",
} as const;

/** What the box is doing now, for the screen. */
export type VoiceStatus = "off" | "listening" | "hearing" | "thinking" | "speaking" | "unavailable";
export type VoiceFailure = "timeout" | "unreachable" | "invalid_reply";

export type VoiceLoopEvent =
  | { type: "status"; status: VoiceStatus }
  /** Final transcript is recorded before a source-linked action is applied. */
  | { type: "heard"; clientTurnId: string; heard: string }
  | { type: "turn"; clientTurnId: string; heard: string | null; reply: string; action: Action | null; answeredBy: TurnResponse["answered_by"] }
  | { type: "failed"; reason: VoiceFailure }
  /** The server named an action that wasn't offered; it was ignored. */
  | { type: "ignored_action"; action: Action };

/** What the scenario engine supplies for each turn. Null when no session is active (clips are dropped). */
export interface VoiceContext {
  sessionId: string;
  language: string;
  state: TurnState;
}

export interface VoiceLoopOptions {
  listener: Listener;
  queue: SpeechQueue;
  voiceTurn: CloudLink["voiceTurn"];
  getContext: () => VoiceContext | null;
  /**
   * An allowed action from the server. For select_step, the owner verifies canonical text, moves to the
   * step, and queues its WAV or local fallback; this loop must not speak the reply again.
   */
  onAction?: (action: Action, response: TurnResponse) => boolean | Promise<boolean>;
  /** Cue sounds: "listening" when the mic opens, "done" when a clip is sent (Speaker.playCue). */
  playCue?: (name: CueName) => Promise<void>;
  onEvent?: (event: VoiceLoopEvent) => void;
  clock?: Clock;
  deadlineMs?: number;
  newId?: () => string;
  log?: Logger;
  lines?: Partial<Record<keyof typeof LOCAL_LINES, string>>;
}

export interface VoiceLoop {
  start(): void;
  stop(): void;
  /** On-screen Talk: stop speaking, drop the turn in flight, start a clip now. */
  pressTalk(): void;
  endPress(): void;
  /** On-screen Stop: stop speaking and drop the turn in flight; listening resumes. */
  interrupt(): void;
  /** A typed turn (simulator, screen keyboard). */
  sendText(text: string): Promise<void>;
  readonly status: VoiceStatus;
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** The listener's resume is held while the queue plays, a turn is out, or the listening cue plays. */
class VoiceLoopImpl implements VoiceLoop {
  private running = false;
  private turn: AbortController | null = null;
  private cueDue = false;
  private cueing = false;
  private current: VoiceStatus = "off";
  private micAvailable = true;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly lines: Record<keyof typeof LOCAL_LINES, string>;

  constructor(private readonly o: VoiceLoopOptions) {
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? silentLogger;
    this.lines = { ...LOCAL_LINES, ...o.lines };
    o.queue.onIdle(() => this.settle());
    // Our own queue also says when playback starts, so lines queued elsewhere (a touched step) pause the mic too.
    (o.queue as Partial<{ onBusy(listener: () => void): void }>).onBusy?.(() => {
      if (!this.running) return;
      this.o.listener.pause();
      this.setStatus("speaking");
    });
  }

  get status(): VoiceStatus {
    return this.current;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.o.listener.start((clip) => void this.onClip(clip), (active) => this.onActivity(active), (available) => this.onAvailability(available));
    this.o.listener.pause();
    this.cueDue = true;
    if (this.o.queue.busy) this.setStatus("speaking");
    else this.settle();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.turn?.abort();
    this.turn = null;
    this.o.queue.stopAll();
    this.o.listener.stop();
    this.setStatus("off");
  }

  pressTalk(): void {
    if (!this.running) return;
    this.dropTurn();
    this.o.listener.pressTalk();
    this.setStatus("listening");
  }

  endPress(): void {
    if (this.running) this.o.listener.endPress();
  }

  interrupt(): void {
    if (!this.running) return;
    this.dropTurn();
    this.settle();
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!this.running || !trimmed) return;
    this.dropTurn();
    await this.runTurn({ type: "text", text: trimmed.slice(0, 500) });
  }

  private dropTurn(): void {
    this.turn?.abort();
    this.turn = null;
    this.cueDue = false;
    this.o.queue.stopAll();
  }

  private async onClip(clip: Clip): Promise<void> {
    // A clip while a turn is out or the box is speaking is the box hearing itself (or a race): drop it.
    if (!this.running || this.turn || this.o.queue.busy) {
      clip.wav.fill(0);
      return;
    }
    const input: TurnInput = {
      type: "audio",
      mime: "audio/wav",
      data_base64: clip.wav.toString("base64"),
      duration_ms: Math.min(CLIP_MAX_MS, Math.max(0, Math.round(clip.durationMs))),
    };
    clip.wav.fill(0);
    if (this.o.playCue) void this.o.playCue("done").catch(() => {});
    await this.runTurn(input);
  }

  private onActivity(active: boolean): void {
    if (!this.running || !this.micAvailable || this.turn || this.o.queue.busy) return;
    if (active) {
      this.setStatus("hearing");
      return;
    }
    // A completed clip starts a turn synchronously; defer READY to avoid flashing it before PROCESSING.
    queueMicrotask(() => {
      if (this.running && !this.turn && !this.o.queue.busy) this.setStatus("listening");
    });
  }

  private onAvailability(available: boolean): void {
    this.micAvailable = available;
    if (!this.running) return;
    if (!available) {
      if (!this.turn && !this.o.queue.busy) this.setStatus("unavailable");
    } else if (this.current === "unavailable") {
      this.settle();
    }
  }

  private async runTurn(input: TurnInput): Promise<void> {
    const context = this.o.getContext();
    if (!context) return; // no session: nothing to talk about
    const turn = new AbortController();
    this.turn = turn;
    this.o.listener.pause();
    this.setStatus("thinking");
    const request: TurnRequest = {
      schema_version: VOICE_TURN_VERSION,
      client_turn_id: (this.o.newId ?? randomUUID)(),
      session_id: context.sessionId,
      language: context.language,
      input,
      state: context.state,
    };
    const started = this.clock.now();
    let response: TurnResponse;
    try {
      response = await this.withDeadline(turn, (signal) => this.o.voiceTurn(request, signal));
    } catch (error) {
      if (this.turn !== turn) return; // interrupted or stopped: say nothing
      const reason: VoiceFailure = turn.signal.reason instanceof TimeoutError ? "timeout" : "unreachable";
      this.log.warn("voice turn failed", { reason, ms: Math.round(this.clock.now() - started), error: (error as Error).message });
      return this.fail(turn, reason);
    }
    if (this.turn !== turn) return;

    const parsed = TurnResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.client_turn_id !== request.client_turn_id) {
      this.log.warn("voice turn reply was not usable", { ms: Math.round(this.clock.now() - started) });
      return this.fail(turn, "invalid_reply");
    }
    const reply = parsed.data;
    let action = reply.action;
    if (action && !actionAllowed(action, request.state)) {
      this.log.warn("ignored an action that was not offered", { action: action.name });
      this.emit({ type: "ignored_action", action });
      action = null;
    }
    if (reply.heard?.trim()) this.emit({ type: "heard", clientTurnId: request.client_turn_id, heard: reply.heard });
    let actionRefused = false;
    if (action && this.o.onAction) {
      try {
        actionRefused = !(await this.o.onAction(action, reply));
      } catch (error) {
        this.log.error("voice action handler failed", { action: action.name, error: (error as Error).message });
        actionRefused = true;
      }
      if (this.turn !== turn) return;
    }
    if (actionRefused) {
      this.log.warn("voice action refused locally", { action: action?.name });
      if (action) this.emit({ type: "ignored_action", action });
      action = null;
    }
    const spokenReply = actionRefused ? "I couldn't complete that request. Please try again." : reply.reply;
    this.log.info("voice turn", { answered_by: reply.answered_by, reason: reply.reason, action: action?.name ?? "none", ms: Math.round(this.clock.now() - started) });
    this.emit({ type: "turn", clientTurnId: request.client_turn_id, heard: reply.heard, reply: spokenReply, action, answeredBy: reply.answered_by });
    if (action?.name !== "select_step") {
      // The server can silently reject an obvious noise/filler transcript. Do not turn that
      // deliberate empty reply into the local "didn't catch that" fallback.
      const silentNotHeard = reply.answered_by === "fixed" && reply.reason === "not_heard" && reply.heard === null
        && !action && reply.speech === null && !reply.reply.trim();
      const text = spokenReply.trim() || (action || silentNotHeard ? "" : this.lines.notCaught);
      if (text) {
        this.setStatus("speaking");
        const wav = !actionRefused && reply.speech ? Buffer.from(reply.speech.data_base64, "base64") : undefined;
        await this.o.queue.say(wav ? { text, wav } : { text });
        if (this.turn !== turn) return;
      }
    }
    this.finish(turn);
  }

  private async fail(turn: AbortController, reason: VoiceFailure): Promise<void> {
    this.emit({ type: "failed", reason });
    this.setStatus("speaking");
    await this.o.queue.say({ text: reason === "timeout" ? this.lines.timeout : reason === "unreachable" ? this.lines.unreachable : this.lines.notCaught });
    if (this.turn === turn) this.finish(turn);
  }

  private finish(turn: AbortController): void {
    if (this.turn !== turn) return;
    this.turn = null;
    this.cueDue = true;
    this.settle();
  }

  /** Rejects at the deadline even if `work` ignores its signal. */
  private withDeadline<T>(turn: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ms = this.o.deadlineMs ?? VOICE_TURN_DEADLINE_MS;
    const cancel = this.clock.setTimeout(() => turn.abort(new TimeoutError(`no answer after ${ms} ms`)), ms);
    const aborted = new Promise<never>((_, reject) => {
      if (turn.signal.aborted) reject(turn.signal.reason);
      turn.signal.addEventListener("abort", () => reject(turn.signal.reason as Error), { once: true });
    });
    aborted.catch(() => {});
    return Promise.race([work(turn.signal), aborted]).finally(cancel);
  }

  /** Opens the mic when nothing holds it: no turn out, nothing playing, no cue playing. */
  private settle(): void {
    if (!this.running || this.turn || this.o.queue.busy || this.cueing) return;
    if (!this.micAvailable) {
      this.setStatus("unavailable");
      return;
    }
    if (this.cueDue && this.o.playCue) {
      this.cueDue = false;
      this.cueing = true;
      let cancel = () => {};
      const capped = new Promise<void>((resolve) => (cancel = this.clock.setTimeout(resolve, LISTENING_CUE_MAX_MS)));
      void Promise.race([this.o.playCue("listening").catch(() => {}), capped]).then(() => {
        cancel();
        this.cueing = false;
        this.settle();
      });
      return;
    }
    this.cueDue = false;
    this.o.listener.resume();
    this.setStatus("listening");
  }

  private setStatus(status: VoiceStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.emit({ type: "status", status });
  }

  private emit(event: VoiceLoopEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch (error) {
      this.log.error("voice event listener threw", { error: (error as Error).message });
    }
  }
}

export function createVoiceLoop(options: VoiceLoopOptions): VoiceLoop {
  return new VoiceLoopImpl(options);
}

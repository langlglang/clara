// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/service.ts (the VoiceQueue class).
import type { Speaker, SpeechQueue, Utterance } from "../ports.js";
import { systemClock, type Cancel, type Clock } from "./clock.js";
import { SPEECH_LINE_MAX_MS } from "./constants.js";
import { silentLogger, type Logger } from "./log.js";

export interface SpeechQueueOptions {
  clock?: Clock;
  log?: Logger;
  /** A line still playing after this is stopped and the queue moves on. */
  lineLimitMs?: number;
  /** A line failed (and maybe fell back to the box's voice) or hit the limit. */
  onError?: (error: Error) => void;
}

interface Item {
  text: string;
  wav?: Buffer;
  file?: string;
  cancelled: boolean;
  resolve: () => void;
}

/**
 * Plays lines one after another through one speaker, so two never overlap. A recorded file or the server's
 * WAV is tried first; if it fails, the box's own voice says `text`. `stopAll` silences the current line and
 * drops the rest (a Talk or Stop tap).
 *
 * Beyond the SpeechQueue port, `onBusy` tells the voice loop the moment playback starts, so the mic can be
 * paused even for lines it didn't queue (half-duplex).
 */
export class PlayerQueue implements SpeechQueue {
  private queue: Item[] = [];
  private current: { item: Item; utterance: Utterance } | null = null;
  private running = false;
  private isMuted = false;
  private readonly idleListeners: Array<() => void> = [];
  private readonly busyListeners: Array<() => void> = [];
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(
    private readonly speaker: Speaker,
    private readonly options: SpeechQueueOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) this.stopAll();
  }

  onIdle(listener: () => void): void {
    this.idleListeners.push(listener);
  }

  onBusy(listener: () => void): void {
    this.busyListeners.push(listener);
  }

  say(item: { text: string; wav?: Buffer; file?: string }): Promise<void> {
    if (this.isMuted) return Promise.resolve();
    if (!item.text.trim() && !item.wav && !item.file) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ ...item, cancelled: false, resolve });
      if (!this.running) void this.drain();
    });
  }

  stopAll(): void {
    for (const item of this.queue.splice(0)) {
      item.cancelled = true;
      item.resolve();
    }
    if (this.current) {
      this.current.item.cancelled = true;
      this.current.utterance.stop();
    }
  }

  /** One loop plays everything, so two lines can never play at once. */
  private async drain(): Promise<void> {
    this.running = true;
    this.emit(this.busyListeners);
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        const { text, wav, file } = item;
        const recorded = file !== undefined ? () => this.speaker.playFile(file) : wav ? () => this.speaker.playWav(wav) : null;
        const played = await this.play(item, recorded ?? (() => this.speaker.speak(text)));
        if (!played && recorded && text.trim()) await this.play(item, () => this.speaker.speak(text));
        item.resolve();
      }
    } finally {
      this.running = false;
      this.emit(this.idleListeners);
    }
  }

  /** False when the line failed; true when it played, was stopped, or hit the time limit. */
  private async play(item: Item, start: () => Utterance): Promise<boolean> {
    if (item.cancelled) return true;
    let cancelLimit: Cancel = () => {};
    try {
      const utterance = start();
      this.current = { item, utterance };
      utterance.done.catch(() => {}); // still awaited below; this only covers a rejection after the limit won
      const limitMs = this.options.lineLimitMs ?? SPEECH_LINE_MAX_MS;
      // A player that never finishes must not hold every later line: stop it and move on.
      const limit = new Promise<void>((resolve) => {
        cancelLimit = this.clock.setTimeout(() => {
          utterance.stop();
          this.fail(new Error(`a line was still playing after ${limitMs} ms`));
          resolve();
        }, limitMs);
      });
      await Promise.race([utterance.done, limit]);
      return true;
    } catch (error) {
      if (item.cancelled) return true;
      this.fail(error as Error);
      return false;
    } finally {
      cancelLimit();
      this.current = null;
    }
  }

  private fail(error: Error): void {
    this.log.warn("playback failed", { error: error.message });
    this.options.onError?.(error);
  }

  private emit(listeners: ReadonlyArray<() => void>): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.log.error("speech queue listener threw", { error: (error as Error).message });
      }
    }
  }
}

export function createSpeechQueue(speaker: Speaker, options: SpeechQueueOptions = {}): PlayerQueue {
  return new PlayerQueue(speaker, options);
}

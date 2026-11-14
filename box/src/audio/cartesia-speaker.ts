import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CueName, Speaker, Utterance } from "../ports.js";

/**
 * Clara's Cartesia voice for the box's own lines (fixed lines, step text, greetings): everything the box would
 * otherwise say in its robotic local voice. Each line is fetched once from the server (/api/boxes/:id/speech) and
 * saved on the Pi, so a line heard (or prepared) once keeps Clara's voice even offline. The local voice (Piper) only
 * speaks a line the box has never had from Cartesia while it can't reach the server: the box must never go silent
 * in an emergency.
 */
export interface CartesiaSpeakerOptions {
  /** Asks the server for one line as a WAV; null when it can't (offline, no key, Cartesia down). */
  fetchWav: (text: string, language: string, signal: AbortSignal) => Promise<Buffer | null>;
  /** The language the box speaks now. */
  language: () => string;
  /** Where voiced lines are kept (survives restarts); null keeps them in memory only. */
  cacheDir: string | null;
  /** How long a line may wait for the server before the local voice says it instead. */
  fetchTimeoutMs?: number;
  log?: (line: string) => void;
}

const CACHE_VERSION = "v1";

export class CartesiaSpeaker implements Speaker {
  private readonly memory = new Map<string, Buffer>();
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly cacheDir: string | null;

  constructor(
    private readonly inner: Speaker,
    private readonly o: CartesiaSpeakerOptions,
  ) {
    this.timeoutMs = o.fetchTimeoutMs ?? 4_000;
    this.log = o.log ?? (() => {});
    let dir = o.cacheDir;
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        this.log(`voice cache not available (${(error as Error).message}); lines are kept in memory only`);
        dir = null;
      }
    }
    this.cacheDir = dir;
  }

  get label(): string {
    return `Cartesia (cached) + ${this.inner.label}`;
  }

  get simulated(): boolean {
    return this.inner.simulated;
  }

  speak(text: string): Utterance {
    const language = this.o.language();
    const cached = this.cached(text, language);
    if (cached) return this.inner.playWav(cached);
    // Not voiced yet: ask the server, then play Clara's voice; the local voice only if that fails.
    let stopped = false;
    let current: Utterance | null = null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const done = this.voice(text, language, abort.signal)
      .catch(() => null)
      .then((wav) => {
        clearTimeout(timer);
        if (stopped) return;
        current = wav ? this.inner.playWav(wav) : this.inner.speak(text);
        return current.done;
      });
    return {
      done,
      stop: () => {
        stopped = true;
        abort.abort();
        current?.stop();
      },
    };
  }

  playWav(wav: Buffer): Utterance {
    return this.inner.playWav(wav);
  }

  playFile(path: string): Utterance {
    return this.inner.playFile(path);
  }

  playCue(name: CueName): Promise<void> {
    return this.inner.playCue(name);
  }

  /**
   * Voices lines ahead of time (in the background, one at a time) so they play in Clara's voice at once, and
   * offline too. Stops early after a few failures in a row (offline). Returns how many were newly voiced.
   */
  async prepare(lines: readonly { text: string; language: string }[], signal?: AbortSignal): Promise<number> {
    let added = 0;
    let failures = 0;
    for (const { text, language } of lines) {
      if (signal?.aborted || failures >= 3) break;
      if (!text.trim() || this.cached(text, language)) continue;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);
      const wav = await this.voice(text, language, signal ? AbortSignal.any([signal, abort.signal]) : abort.signal).catch(() => null);
      clearTimeout(timer);
      if (wav) {
        added++;
        failures = 0;
      } else failures++;
    }
    return added;
  }

  private async voice(text: string, language: string, signal: AbortSignal): Promise<Buffer | null> {
    const wav = await this.o.fetchWav(text, language, signal);
    if (!wav || wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF") return null;
    this.save(text, language, wav);
    return wav;
  }

  private key(text: string, language: string): string {
    return createHash("sha256").update(`${CACHE_VERSION}\u0000${language}\u0000${text.trim()}`).digest("hex").slice(0, 32);
  }

  private cached(text: string, language: string): Buffer | null {
    const key = this.key(text, language);
    const hit = this.memory.get(key);
    if (hit) return hit;
    if (!this.cacheDir) return null;
    const file = join(this.cacheDir, `${key}.wav`);
    if (!existsSync(file)) return null;
    try {
      // Read once, then serve from memory.
      const wav = readFileSync(file);
      this.memory.set(key, wav);
      return wav;
    } catch {
      return null;
    }
  }

  private save(text: string, language: string, wav: Buffer): void {
    const key = this.key(text, language);
    this.memory.set(key, wav);
    if (this.memory.size > 500) this.memory.delete(this.memory.keys().next().value!);
    if (!this.cacheDir) return;
    try {
      // Write then rename, so a power cut never leaves a half-written line that plays as noise.
      const file = join(this.cacheDir, `${key}.wav`);
      writeFileSync(`${file}.tmp`, wav);
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.log(`voice cache write failed (${(error as Error).message})`);
    }
  }
}

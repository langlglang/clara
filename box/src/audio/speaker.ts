// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/audio/speech.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CueName, Speaker, Utterance } from "../ports.js";
import { systemClock, type Clock } from "./clock.js";
import { CUE_PLAYER_MAX_MS, PLAYER_KILL_GRACE_MS } from "./constants.js";
import { cueWav, writeCueSounds } from "./cues.js";
import { silentLogger, type Logger } from "./log.js";
import { realSpawn, signalChild, type SpawnFn } from "./process.js";

interface Running {
  done: Promise<void>;
  kill(): void;
}

interface RunDeps {
  spawn: SpawnFn;
  clock: Clock;
}

/**
 * Runs one command; resolves on exit 0, or quietly when killed on purpose. Stopped by `limitMs` counts as a
 * failure (a hung player). Text and audio always go in on stdin, never as a command-line argument.
 */
function run(deps: RunDeps, command: string, args: readonly string[], stdin?: string | Buffer, limitMs?: number): Running {
  const child = deps.spawn(command, [...args], { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
  let killed = false;
  let timedOut = false;
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    if (stderr.length < 500) stderr += data.toString();
  });
  let cancelLimit = () => {};
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      cancelLimit();
      reject(new Error(`${command}: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    });
    child.once("close", (code) => {
      cancelLimit();
      if (timedOut) reject(new Error(`${command} was still running after ${limitMs} ms`));
      else if (code === 0 || killed) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
  if (stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  }
  const kill = () => {
    killed = true;
    signalChild(child, "SIGTERM");
    // A player that ignores SIGTERM would block every later line in the speech queue.
    setTimeout(() => signalChild(child, "SIGKILL"), PLAYER_KILL_GRACE_MS).unref();
  };
  if (limitMs !== undefined) {
    cancelLimit = deps.clock.setTimeout(() => {
      timedOut = true;
      kill();
    }, limitMs);
  }
  return { done, kill };
}

/** A chain of steps where `stop()` kills the current step and skips the rest. */
function sequence(steps: Array<() => Running>, cleanup: () => void = () => {}): Utterance {
  let current: Running | null = null;
  let stopped = false;
  const done = (async () => {
    try {
      for (const step of steps) {
        if (stopped) return;
        current = step();
        await current.done;
      }
    } finally {
      cleanup();
    }
  })();
  return {
    done,
    stop: () => {
      stopped = true;
      current?.kill();
    },
  };
}

export interface PiSpeakerOptions {
  /** ALSA playback device, for example `plughw:CARD=Device,DEV=0` or `default`. */
  device: string;
  /** Piper voice model (.onnx). Without one, espeak-ng speaks. */
  piperModel?: string | null;
  /** espeak-ng voice (a language code such as `en` or `ar`). */
  espeakVoice?: string;
  /** Private folder for synthesized lines (emptied at start; each file is deleted after playing). */
  tmpDir?: string;
  spawn?: SpawnFn;
  clock?: Clock;
  log?: Logger;
}

/**
 * The Pi: aplay over ALSA for the server's voice, recorded step clips and cues; Piper (falling back to
 * espeak-ng) for the box's own voice.
 */
export class PiSpeaker implements Speaker {
  readonly simulated = false;
  readonly label: string;
  private counter = 0;
  private readonly deps: RunDeps;
  private readonly log: Logger;
  private readonly tmpDir: string;

  constructor(private readonly options: PiSpeakerOptions) {
    this.deps = { spawn: options.spawn ?? realSpawn, clock: options.clock ?? systemClock };
    this.log = options.log ?? silentLogger;
    this.tmpDir = options.tmpDir ?? join(tmpdir(), "clara-speech");
    // Leftovers from a crash or power cut are removed; the folder itself is kept so it stays private.
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.tmpDir)) rmSync(join(this.tmpDir, name), { recursive: true, force: true });
    this.label = `aplay on ${options.device}, ${options.piperModel ? "piper (espeak-ng fallback)" : "espeak-ng"}`;
  }

  speak(text: string): Utterance {
    this.counter += 1;
    const file = join(this.tmpDir, `speech-${this.counter}.wav`);
    const { piperModel, device } = this.options;
    const espeakArgs = [...(this.options.espeakVoice ? ["-v", this.options.espeakVoice] : []), "--stdin", "-w", file];
    let current: Running | null = null;
    let stopped = false;
    const done = (async () => {
      try {
        let synthesized = false;
        if (piperModel) {
          current = run(this.deps, "piper", ["--model", piperModel, "--output_file", file], text);
          try {
            await current.done;
            synthesized = true;
          } catch (error) {
            if (stopped) return;
            this.log.warn("piper failed; using espeak-ng", { error: (error as Error).message });
          }
        }
        if (stopped) return;
        if (!synthesized) {
          current = run(this.deps, "espeak-ng", espeakArgs, text);
          await current.done;
        }
        if (stopped) return;
        current = run(this.deps, "aplay", ["-q", "-D", device, file]);
        await current.done;
      } finally {
        rmSync(file, { force: true });
      }
    })();
    return {
      done,
      stop: () => {
        stopped = true;
        (current as Running | null)?.kill();
      },
    };
  }

  /** Pipes the WAV into aplay's stdin, so the reply's audio never touches the disk. */
  playWav(wav: Buffer): Utterance {
    return sequence([() => run(this.deps, "aplay", ["-q", "-D", this.options.device, "-"], wav)]);
  }

  playFile(path: string): Utterance {
    return sequence([() => run(this.deps, "aplay", ["-q", "-D", this.options.device, path])]);
  }

  playCue(name: CueName): Promise<void> {
    return run(this.deps, "aplay", ["-q", "-D", this.options.device, "-"], cueWav(name), CUE_PLAYER_MAX_MS).done;
  }
}

/** The Mac, out loud: `say` for speech and `afplay` for audio. Opt-in for the simulator. */
export class MacSpeaker implements Speaker {
  readonly simulated = true;
  readonly label = "Mac speakers (say, afplay)";
  private readonly deps: RunDeps;
  private cues: Record<CueName, string> | null = null;
  private readonly dir: string;

  constructor(options: { spawn?: SpawnFn; clock?: Clock; tmpDir?: string } = {}) {
    this.deps = { spawn: options.spawn ?? realSpawn, clock: options.clock ?? systemClock };
    this.dir = options.tmpDir ?? join(tmpdir(), "clara-sim-audio");
  }

  speak(text: string): Utterance {
    return sequence([() => run(this.deps, "say", [], text)]);
  }

  /** afplay needs a file, so the WAV goes to a private temp file that is deleted after playing. */
  playWav(wav: Buffer): Utterance {
    const dir = mkdtempSync(join(tmpdir(), "clara-sim-speech-"));
    const file = join(dir, "reply.wav");
    writeFileSync(file, wav, { mode: 0o600 });
    return sequence([() => run(this.deps, "afplay", [file])], () => rmSync(dir, { recursive: true, force: true }));
  }

  playFile(path: string): Utterance {
    return sequence([() => run(this.deps, "afplay", [path])]);
  }

  playCue(name: CueName): Promise<void> {
    this.cues ??= writeCueSounds(this.dir);
    return run(this.deps, "afplay", [this.cues[name]], undefined, CUE_PLAYER_MAX_MS).done;
  }
}

/**
 * Silent, for the simulator and tests on any machine: nothing plays. Each line is reported through `print`
 * and, with `outDir`, the server's voiced replies are kept as numbered WAV files there to play by hand.
 * A missing step file fails, so the speech queue's fallback to the box's own voice runs as on the Pi.
 */
export class SilentSpeaker implements Speaker {
  readonly simulated = true;
  readonly label: string;
  private counter = 0;

  constructor(private readonly options: { outDir?: string | null; print?: (line: string) => void } = {}) {
    if (options.outDir) mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
    this.label = options.outDir ? `silent (replies saved in ${options.outDir})` : "silent";
  }

  speak(text: string): Utterance {
    this.print(`Clara (box voice): ${text}`);
    return { done: Promise.resolve(), stop: () => {} };
  }

  playWav(wav: Buffer): Utterance {
    this.counter += 1;
    if (this.options.outDir) {
      const file = join(this.options.outDir, `${String(this.counter).padStart(3, "0")}-reply.wav`);
      writeFileSync(file, wav);
      this.print(`Clara (server voice): ${file}`);
    } else this.print(`Clara (server voice): ${wav.length} bytes`);
    return { done: Promise.resolve(), stop: () => {} };
  }

  playFile(path: string): Utterance {
    if (!existsSync(path)) return { done: Promise.reject(new Error(`${path} is missing`)), stop: () => {} };
    this.print(`Clara (recording): ${path}`);
    return { done: Promise.resolve(), stop: () => {} };
  }

  playCue(name: CueName): Promise<void> {
    this.print(`(cue: ${name})`);
    return Promise.resolve();
  }

  private print(line: string): void {
    this.options.print?.(line);
  }
}

export type SpeakerOptions =
  | ({ kind: "pi" } & PiSpeakerOptions)
  | { kind: "mac"; spawn?: SpawnFn; clock?: Clock; tmpDir?: string }
  | { kind: "silent"; outDir?: string | null; print?: (line: string) => void };

export function createSpeaker(options: SpeakerOptions): Speaker {
  switch (options.kind) {
    case "pi":
      return new PiSpeaker(options);
    case "mac":
      return new MacSpeaker(options);
    case "silent":
      return new SilentSpeaker(options);
  }
}

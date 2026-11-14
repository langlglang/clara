// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/audio/capture.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CaptureSession, Microphone } from "../ports.js";
import { CLIP_MAX_PCM_BYTES, CLIP_SAMPLE_RATE } from "./constants.js";
import { silentLogger, type Logger } from "./log.js";
import { realSpawn, signalChild, type SpawnFn } from "./process.js";
import { clipFromPcm, isClipFormat, readWav } from "./wav.js";

/** A live stream of raw 16 kHz mono 16-bit PCM, for hands-free listening. */
export interface PcmStream {
  stop(): void;
}

/**
 * A microphone that can also stream continuously (arecord, ffmpeg). The hands-free Listener needs this; a
 * plain Microphone (the file simulator) only supports the Talk button.
 */
export interface StreamingMicrophone extends Microphone {
  /** `onEnd` is called once if the stream stops by itself (unplugged, command missing), never after `stop()`. */
  stream(onPcm: (pcm: Buffer) => void, onEnd: (error: Error) => void): PcmStream;
}

export function isStreaming(mic: Microphone): mic is StreamingMicrophone {
  return typeof (mic as Partial<StreamingMicrophone>).stream === "function";
}

/**
 * Records raw 16 kHz mono 16-bit PCM from a command's stdout (arecord on the Pi, ffmpeg on a Mac).
 * Nothing is written to disk; a clip keeps at most 15 s.
 */
export class CommandMicrophone implements StreamingMicrophone {
  constructor(
    readonly label: string,
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly log: Logger = silentLogger,
    readonly simulated = false,
    private readonly spawnChild: SpawnFn = realSpawn,
  ) {}

  start(): CaptureSession {
    const child = this.spawnChild(this.command, [...this.args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let exited = false;
    // A command that can't start emits "error" and may never emit "close", so either one ends the recording.
    const exit = new Promise<void>((resolve) => {
      child.once("close", () => ((exited = true), resolve()));
      child.once("error", (error) => {
        failure = new Error(`${this.command} could not start (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
        exited = true;
        resolve();
      });
    });
    child.stdout?.on("data", (data: Buffer) => {
      if (bytes >= CLIP_MAX_PCM_BYTES) return;
      const part = data.subarray(0, CLIP_MAX_PCM_BYTES - bytes);
      chunks.push(Buffer.from(part));
      bytes += part.length;
    });
    child.stderr?.on("data", () => {});
    const wipe = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };

    return {
      stop: async () => {
        if (!exited) signalChild(child, "SIGINT");
        const killer = setTimeout(() => signalChild(child, "SIGKILL"), 2000);
        await exit;
        clearTimeout(killer);
        if (failure) throw failure;
        if (bytes === 0) throw new Error(`${this.command} recorded nothing (exit ${child.exitCode ?? child.signalCode}).`);
        const pcm = Buffer.concat(chunks);
        const clip = clipFromPcm(pcm);
        pcm.fill(0);
        wipe();
        return clip;
      },
      abort: () => {
        if (!exited) signalChild(child, "SIGKILL");
        wipe();
      },
    };
  }

  stream(onPcm: (pcm: Buffer) => void, onEnd: (error: Error) => void): PcmStream {
    const child = this.spawnChild(this.command, [...this.args], { stdio: ["ignore", "pipe", "pipe"] });
    let stopped = false;
    let ended = false;
    const end = (error: Error) => {
      if (ended) return;
      ended = true;
      if (!stopped) onEnd(error);
    };
    child.stdout?.on("data", (data: Buffer) => {
      if (!stopped) onPcm(data);
    });
    child.stderr?.on("data", () => {});
    child.once("error", (error) =>
      end(new Error(`${this.command} could not start (${(error as NodeJS.ErrnoException).code ?? "error"}).`)),
    );
    child.once("close", (code, signal) => end(new Error(`${this.command} exited (${code ?? signal}).`)));
    this.log.info("mic stream open", { mic: this.label });
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        signalChild(child, "SIGTERM");
        setTimeout(() => signalChild(child, "SIGKILL"), 2000).unref();
      },
    };
  }
}

/** arecord's arguments for the clip format (raw 16 kHz mono 16-bit PCM to stdout). */
export function arecordArgs(device: string): string[] {
  return ["-q", "-D", device, "-f", "S16_LE", "-r", String(CLIP_SAMPLE_RATE), "-c", "1", "-t", "raw"];
}

/** The Pi's USB microphone through ALSA, by device name (for example `plughw:CARD=Device,DEV=0`). */
export function piMicrophone(device: string, log?: Logger, spawnChild?: SpawnFn): CommandMicrophone {
  return new CommandMicrophone(`arecord on ${device}`, "arecord", arecordArgs(device), log, false, spawnChild);
}

/**
 * The Mac's microphone through ffmpeg (AVFoundation). Opt-in only: it records whoever is nearby and makes
 * macOS ask for microphone permission, so no test or default run uses it.
 */
export function macMicrophone(device = "0", log?: Logger, spawnChild?: SpawnFn): CommandMicrophone {
  return new CommandMicrophone(
    `Mac microphone ${device}`,
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", `:${device}`, "-ac", "1", "-ar", String(CLIP_SAMPLE_RATE), "-f", "s16le", "-"],
    log,
    true,
    spawnChild,
  );
}

/** A file-mic value as a list of clips: a WAV, a comma-separated list, or a folder (its .wav files by name). */
export function resolveMicFiles(value: string): string[] {
  const paths: string[] = [];
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (statSync(part).isDirectory()) {
      // Natural order (2- before 10-), and no hidden files (macOS writes ._name.wav next to copied clips).
      const wavs = readdirSync(part)
        .filter((name) => !name.startsWith(".") && name.toLowerCase().endsWith(".wav"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (wavs.length === 0) throw new Error(`${part} has no .wav files.`);
      paths.push(...wavs.map((name) => join(part, name)));
    } else {
      paths.push(part);
    }
  }
  if (paths.length === 0) throw new Error("The file mic needs at least one WAV file.");
  return paths;
}

function readClipFile(path: string): Buffer {
  let info: ReturnType<typeof readWav>;
  try {
    info = readWav(readFileSync(path));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (!isClipFormat(info)) {
    throw new Error(`${path} must be a 16 kHz mono 16-bit WAV. Convert it with: ffmpeg -i <input> -ar 16000 -ac 1 -sample_fmt s16 <output>.wav`);
  }
  return Buffer.from(info.pcm);
}

/**
 * The simulator's microphone: each clip taken plays the next prepared WAV file (capped at 15 s), starting
 * again after the last. A press that ends without a clip (aborted) doesn't use one up. Each file is read
 * again at its press, so an edit is picked up. Talk button only: it does not stream.
 */
export class FileMicrophone implements Microphone {
  readonly simulated = true;
  readonly label: string;
  private next = 0;

  constructor(private readonly paths: readonly string[]) {
    if (paths.length === 0) throw new Error("The file mic needs at least one WAV file.");
    for (const path of paths) readClipFile(path); // refuse a bad clip now, not at the third press
    this.label = paths.length === 1 ? `file ${paths[0]}` : `${paths.length} files, in order (${paths[0]} first)`;
  }

  start(): CaptureSession {
    const pcm = readClipFile(this.paths[this.next % this.paths.length]!);
    return {
      stop: async () => {
        this.next += 1;
        const clip = clipFromPcm(pcm);
        pcm.fill(0);
        return clip;
      },
      abort: () => pcm.fill(0),
    };
  }
}

export type MicrophoneOptions =
  | { kind: "pi"; device: string; log?: Logger; spawn?: SpawnFn }
  | { kind: "mac"; device?: string; log?: Logger; spawn?: SpawnFn }
  /** `files`: a WAV path, a comma-separated list, a folder, or an explicit list. */
  | { kind: "file"; files: string | readonly string[] };

export function createMicrophone(options: MicrophoneOptions): Microphone {
  switch (options.kind) {
    case "pi":
      return piMicrophone(options.device, options.log, options.spawn);
    case "mac":
      return macMicrophone(options.device, options.log, options.spawn);
    case "file":
      return new FileMicrophone(typeof options.files === "string" ? resolveMicFiles(options.files) : options.files);
  }
}

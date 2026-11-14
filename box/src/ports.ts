/**
 * The seams between the box's parts. Each part is built against these interfaces so the audio, the
 * ESP32 link, the screen and the cloud link can be written in parallel and swapped for simulators.
 * Shapes follow Sophi's Pi runtime (github.com/mzhao1599/sophi, devices/pi/src).
 */
import type { BoxEvent, BoxPush, CameraInspectRequest, CameraInspectResponse, FromBoard, TurnRequest, TurnResponse } from "@clara/contracts";

// ---------- Audio (box/src/audio) ----------

/** 16 kHz mono 16-bit WAV held in memory only. */
export interface Clip {
  wav: Buffer;
  durationMs: number;
}

export interface CaptureSession {
  stop(): Promise<Clip>;
  abort(): void;
}

/** A raw microphone: arecord on the Pi, ffmpeg on a Mac, or prepared WAV files in the simulator. */
export interface Microphone {
  readonly label: string;
  readonly simulated: boolean;
  start(): CaptureSession;
}

/** Hands-free listening: emits one clip per utterance (voice-activity detection ends it). */
export interface Listener {
  /** True only when this listener captures hands-free without a screen button. */
  readonly handsFree?: boolean;
  start(onClip: (clip: Clip) => void, onActivity?: (active: boolean) => void, onAvailability?: (available: boolean) => void): void;
  /** Half-duplex: paused while the box speaks. */
  pause(): void;
  resume(): void;
  stop(): void;
  /** On-screen Talk button: force-start a clip now, ended by silence or `endPress`. */
  pressTalk(): void;
  endPress(): void;
}

export interface Utterance {
  done: Promise<void>;
  stop(): void;
}

export type CueName = "listening" | "done" | "sos" | "alert" | "error";

export interface Speaker {
  readonly label: string;
  readonly simulated: boolean;
  /** Local voice (Piper, then espeak-ng): for fixed lines and when the server voice is missing. */
  speak(text: string): Utterance;
  /** A WAV the server already voiced (Cartesia). */
  playWav(wav: Buffer): Utterance;
  /** A recorded step clip on disk. */
  playFile(path: string): Utterance;
  playCue(name: CueName): Promise<void>;
}

/** One player for everything, so two lines never overlap. `say` resolves when the line finished or was stopped. */
export interface SpeechQueue {
  say(item: { text: string; wav?: Buffer; file?: string }): Promise<void>;
  stopAll(): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  readonly busy: boolean;
  onIdle(listener: () => void): void;
  /** Fires the moment playback starts, so the mic can pause (half-duplex). */
  onBusy(listener: () => void): void;
}

// ---------- ESP32 board (box/src/hardware) ----------

export type BoardEvent =
  | { type: "connected"; firmware: string; leds: number }
  | { type: "disconnected"; reason: string }
  | Extract<FromBoard, { t: "lid" | "mount" | "pulse" | "sensor.raw" }>;

export interface Board {
  readonly label: string;
  readonly simulated: boolean;
  onEvent(listener: (event: BoardEvent) => void): void;
  /** Light one compartment (others go off). Resolves true when the board acked. */
  lightCompartment(channel: number, ms: number, mode?: "solid" | "blink" | "pulse"): Promise<boolean>;
  clearLights(): Promise<boolean>;
  /** CPR rhythm or SOS flash on all LEDs; 0 stops it. */
  rhythm(bpm: number): Promise<boolean>;
  buzz(pattern: "chime" | "alert" | "off"): Promise<boolean>;
  startPulse(): Promise<boolean>;
  stopPulse(): Promise<boolean>;
  close(): Promise<void>;
}

// ---------- Cloud link (box/src/cloud) ----------

export interface CloudLink {
  /** Appends to the local outbox; sent in order, retried until the server has them. */
  record(event: BoxEvent): void;
  /** Live messages for this box (who is coming, responder messages, nearby emergencies). */
  onPush(listener: (push: BoxPush) => void): void;
  /** One voice turn; rejects on timeout or no link. */
  voiceTurn(request: TurnRequest, signal: AbortSignal): Promise<TurnResponse>;
  /** One consented camera frame; absent in the offline simulator. */
  inspectCamera?(request: CameraInspectRequest, signal: AbortSignal): Promise<CameraInspectResponse>;
  readonly online: boolean;
  onOnlineChange(listener: (online: boolean) => void): void;
  close(): void;
}

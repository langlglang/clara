/**
 * Hands-free listening: an energy voice-activity detector (from Clara's pre-event scaffold, box/src/audio/vad.ts)
 * and the Listener that feeds it from a streaming mic. The Talk-button fallback for non-streaming mics follows
 * Sophi's push-to-talk recording (github.com/mzhao1599/sophi, devices/pi/src/service.ts).
 */
import type { Clip, Listener, Microphone } from "../ports.js";
import { systemClock, type Cancel, type Clock } from "./clock.js";
import { CLIP_MAX_MS, CLIP_MIN_MS, CLIP_SAMPLE_RATE, MIC_RESTART_MS, VAD_END_SILENCE_MS, VAD_PRESS_NO_SPEECH_MS } from "./constants.js";
import { silentLogger, type Logger } from "./log.js";
import { isStreaming, type PcmStream, type StreamingMicrophone } from "./mic.js";
import { bytesFromInt16, int16FromBytes, wavFromPcm } from "./wav.js";

export interface EndpointerOptions {
  sampleRate?: number;
  frameMs?: number;
  /** Speech must last this many consecutive frames to start an utterance. */
  startFrames?: number;
  /** This much silence ends an utterance (docs/voice.md: 0.7 s). */
  endSilenceMs?: number;
  /** Utterances with less speech than this are dropped, a cough or a bump (0.3 s). */
  minSpeechMs?: number;
  /** An utterance is cut here and sent as is (15 s). */
  maxUtteranceMs?: number;
  /** Audio kept from before speech started, so the first syllable isn't lost. */
  preRollMs?: number;
  /** Speech is this many dB above the noise floor... */
  marginDb?: number;
  /** ...and above this absolute level. */
  minLevelDb?: number;
  /** After a Talk press, silence before the first speech may last this long. */
  pressNoSpeechMs?: number;
}

export interface Segment {
  pcm: Int16Array;
  durationMs: number;
}

const dbfs = (frame: Int16Array) => {
  let sum = 0;
  for (const s of frame) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return 20 * Math.log10(Math.max(rms, 1) / 32768);
};

/**
 * Finds where someone starts and stops talking in a stream of 16 kHz mono samples. It tracks the room's
 * noise level while nobody is talking and treats frames clearly above it as speech. Good enough for a demo
 * in a quiet-ish room; a trained detector (for example Silero) is the upgrade if the venue is loud.
 */
export class Endpointer {
  private readonly frameSamples: number;
  private readonly o: Required<EndpointerOptions>;
  private remainder = new Int16Array(0);
  private noiseDb = -60;
  private preRoll: Int16Array[] = [];
  private voicedRun = 0;
  private speaking = false;
  private forced = false;
  private frames: Int16Array[] = [];
  private silentRun = 0;
  private speechFrames = 0;

  constructor(options: EndpointerOptions = {}, private readonly onActivity?: (active: boolean) => void) {
    this.o = {
      sampleRate: CLIP_SAMPLE_RATE,
      frameMs: 20,
      startFrames: 3,
      endSilenceMs: VAD_END_SILENCE_MS,
      minSpeechMs: CLIP_MIN_MS,
      maxUtteranceMs: CLIP_MAX_MS,
      preRollMs: 300,
      marginDb: 12,
      minLevelDb: -50,
      pressNoSpeechMs: VAD_PRESS_NO_SPEECH_MS,
      ...options,
    };
    this.frameSamples = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
  }

  get active(): boolean {
    return this.speaking;
  }

  /** Forgets any partial utterance (used when the mic pauses). The noise estimate is kept. */
  reset(): void {
    if (this.speaking) this.onActivity?.(false);
    for (const f of this.frames) f.fill(0);
    this.remainder = new Int16Array(0);
    this.preRoll = [];
    this.voicedRun = 0;
    this.speaking = false;
    this.forced = false;
    this.frames = [];
    this.silentRun = 0;
    this.speechFrames = 0;
  }

  /** Talk button: start an utterance now. It ends on silence after speech, `flush`, the 15 s cap, or no speech in time. */
  forceStart(): void {
    if (this.speaking && !this.forced) return;
    if (!this.speaking) this.onActivity?.(true);
    this.speaking = true;
    this.forced = true;
    this.frames = [...this.preRoll];
    this.preRoll = [];
    this.speechFrames = 0;
    this.silentRun = 0;
  }

  /** Feeds samples; returns any utterances that ended inside them. */
  push(samples: Int16Array): Segment[] {
    const all = new Int16Array(this.remainder.length + samples.length);
    all.set(this.remainder);
    all.set(samples, this.remainder.length);
    const done: Segment[] = [];
    let at = 0;
    for (; at + this.frameSamples <= all.length; at += this.frameSamples) {
      const segment = this.frame(all.slice(at, at + this.frameSamples));
      if (segment) done.push(segment);
    }
    this.remainder = all.slice(at);
    return done;
  }

  /** Ends any utterance in progress (Talk released). Null when there was none or it was too short. */
  flush(): Segment | null {
    return this.speaking ? this.finish() : null;
  }

  private frame(frame: Int16Array): Segment | null {
    const o = this.o;
    const level = dbfs(frame);
    const voiced = level > Math.max(this.noiseDb + o.marginDb, o.minLevelDb);
    if (!this.speaking) {
      // Track the room slowly while nobody is talking.
      if (!voiced) this.noiseDb = this.noiseDb * 0.95 + level * 0.05;
      this.preRoll.push(frame);
      if (this.preRoll.length > Math.ceil(o.preRollMs / o.frameMs)) this.preRoll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= o.startFrames) {
        this.speaking = true;
        this.onActivity?.(true);
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = this.voicedRun;
        this.silentRun = 0;
      }
      return null;
    }
    this.frames.push(frame);
    if (voiced) {
      this.speechFrames += 1;
      this.silentRun = 0;
    } else {
      this.silentRun += 1;
    }
    // After a press, wait longer for the first words; once someone has spoken, the normal silence rule applies.
    const silenceLimit = this.forced && this.speechFrames === 0 ? o.pressNoSpeechMs : o.endSilenceMs;
    if (this.silentRun * o.frameMs >= silenceLimit || this.frames.length * o.frameMs >= o.maxUtteranceMs) return this.finish();
    return null;
  }

  private finish(): Segment | null {
    const o = this.o;
    // Keep at most 200 ms of the trailing silence.
    const trailing = Math.max(0, this.silentRun - Math.ceil(200 / o.frameMs));
    const frames = this.frames.slice(0, this.frames.length - trailing);
    const speechMs = this.speechFrames * o.frameMs;
    const pcm = speechMs < o.minSpeechMs ? null : new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    if (pcm) {
      let offset = 0;
      for (const f of frames) {
        pcm.set(f, offset);
        offset += f.length;
      }
    }
    this.reset();
    return pcm ? { pcm, durationMs: Math.round((pcm.length / o.sampleRate) * 1000) } : null;
  }
}

export interface ListenerOptions extends EndpointerOptions {
  clock?: Clock;
  log?: Logger;
  /** A mic stream that died is opened again after this long. */
  restartMs?: number;
}

/** A detected segment as a clip (16 kHz mono WAV); the segment's samples are wiped. */
function clipFromSegment(segment: Segment, sampleRate: number): Clip {
  const pcm = bytesFromInt16(segment.pcm);
  segment.pcm.fill(0);
  const wav = wavFromPcm(pcm, sampleRate);
  pcm.fill(0);
  return { wav, durationMs: segment.durationMs };
}

/**
 * Hands-free listening on a streaming mic. The mic stays open while started; while paused (the box speaks
 * or waits for an answer) samples are dropped and any partial utterance is forgotten, so the box never
 * hears itself. Talk forces a clip to start now and unpauses.
 */
export class VadListener implements Listener {
  readonly handsFree = true;
  private readonly endpointer: Endpointer;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly sampleRate: number;
  private onClip: ((clip: Clip) => void) | null = null;
  private onActivity: ((active: boolean) => void) | null = null;
  private onAvailability: ((available: boolean) => void) | null = null;
  private stream: PcmStream | null = null;
  private restart: Cancel | null = null;
  private paused = false;
  private carry: Buffer = Buffer.alloc(0);

  constructor(
    private readonly mic: StreamingMicrophone,
    private readonly options: ListenerOptions = {},
  ) {
    this.endpointer = new Endpointer(options, (active) => this.onActivity?.(active));
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
    this.sampleRate = options.sampleRate ?? CLIP_SAMPLE_RATE;
  }

  start(onClip: (clip: Clip) => void, onActivity?: (active: boolean) => void, onAvailability?: (available: boolean) => void): void {
    if (this.onClip) return;
    this.onClip = onClip;
    this.onActivity = onActivity ?? null;
    this.onAvailability = onAvailability ?? null;
    this.paused = false;
    this.open();
  }

  pause(): void {
    this.paused = true;
    this.endpointer.reset();
    this.carry = Buffer.alloc(0);
  }

  resume(): void {
    this.paused = false;
  }

  stop(): void {
    this.onClip = null;
    this.restart?.();
    this.restart = null;
    this.stream?.stop();
    this.stream = null;
    this.pause();
    this.onActivity = null;
    this.onAvailability = null;
  }

  pressTalk(): void {
    if (!this.onClip) return;
    this.paused = false;
    this.endpointer.forceStart();
  }

  endPress(): void {
    const segment = this.endpointer.flush();
    if (segment) this.deliver(segment);
  }

  private open(): void {
    this.stream = this.mic.stream(
      (data) => this.feed(data),
      (error) => {
        this.stream = null;
        this.endpointer.reset();
        this.onAvailability?.(false);
        if (!this.onClip) return;
        this.log.warn("mic stream ended; opening it again", { mic: this.mic.label, error: error.message });
        this.restart = this.clock.setTimeout(() => {
          this.restart = null;
          if (this.onClip) this.open();
        }, this.options.restartMs ?? MIC_RESTART_MS);
      },
    );
    this.onAvailability?.(true);
  }

  private feed(data: Buffer): void {
    if (this.paused || !this.onClip) return;
    const bytes = this.carry.length ? Buffer.concat([this.carry, data]) : data;
    const even = bytes.length - (bytes.length % 2);
    this.carry = Buffer.from(bytes.subarray(even));
    for (const segment of this.endpointer.push(int16FromBytes(bytes.subarray(0, even)))) {
      this.deliver(segment);
      if (this.paused) break; // the clip handler paused us: drop the rest of this chunk
    }
  }

  private deliver(segment: Segment): void {
    if (!this.onClip) {
      segment.pcm.fill(0);
      return;
    }
    this.onClip(clipFromSegment(segment, this.sampleRate));
  }
}

/**
 * The Talk button alone, for a mic that can't stream (the file simulator): `pressTalk` starts a capture and
 * `endPress` (or the 15 s cap) sends it. Clips under 0.3 s are dropped.
 */
export class PressListener implements Listener {
  readonly handsFree = false;
  private readonly clock: Clock;
  private readonly log: Logger;
  private onClip: ((clip: Clip) => void) | null = null;
  private session: { capture: ReturnType<Microphone["start"]>; cancelMax: Cancel } | null = null;

  constructor(
    private readonly mic: Microphone,
    private readonly options: ListenerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? silentLogger;
  }

  start(onClip: (clip: Clip) => void): void {
    this.onClip = onClip;
  }

  pause(): void {
    this.abort();
  }

  resume(): void {}

  stop(): void {
    this.abort();
    this.onClip = null;
  }

  pressTalk(): void {
    if (!this.onClip || this.session) return;
    const capture = this.mic.start();
    const cancelMax = this.clock.setTimeout(() => this.endPress(), this.options.maxUtteranceMs ?? CLIP_MAX_MS);
    this.session = { capture, cancelMax };
  }

  endPress(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.cancelMax();
    session.capture.stop().then(
      (clip) => {
        if (!this.onClip || clip.durationMs < (this.options.minSpeechMs ?? CLIP_MIN_MS)) return void clip.wav.fill(0);
        this.onClip(clip);
      },
      (error: Error) => this.log.warn("recording failed", { mic: this.mic.label, error: error.message }),
    );
  }

  private abort(): void {
    const session = this.session;
    this.session = null;
    session?.cancelMax();
    session?.capture.abort();
  }
}

/** Hands-free (voice-activity detection) on a streaming mic; Talk button only on one that can't stream. */
export function createListener(mic: Microphone, options: ListenerOptions = {}): Listener {
  return isStreaming(mic) ? new VadListener(mic, options) : new PressListener(mic, options);
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileMicrophone, type PcmStream, type StreamingMicrophone } from "../src/audio/mic.js";
import { createListener, Endpointer, PressListener, VadListener } from "../src/audio/vad.js";
import { bytesFromInt16, readWav, wavFromPcm } from "../src/audio/wav.js";
import type { Clip } from "../src/ports.js";
import { FakeClock, flush } from "./audio-fakes.js";

const RATE = 16_000;
/** Low noise (about -56 dBFS) or a loud tone (about -15 dBFS), for `ms` milliseconds. */
function signal(parts: { ms: number; loud: boolean }[]): Int16Array {
  const total = parts.reduce((n, p) => n + (p.ms * RATE) / 1000, 0);
  const out = new Int16Array(total);
  let i = 0;
  let seed = 1;
  for (const part of parts) {
    for (let k = 0; k < (part.ms * RATE) / 1000; k++, i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((seed / 0x7fffffff) * 2 - 1) * 50;
      out[i] = part.loud ? Math.round(8_000 * Math.sin((2 * Math.PI * 220 * i) / RATE)) : Math.round(noise);
    }
  }
  return out;
}

/** Feeds in 100 ms chunks, like a live stream. */
function feed(endpointer: Endpointer, samples: Int16Array) {
  const out = [];
  for (let at = 0; at < samples.length; at += 1_600) out.push(...endpointer.push(samples.subarray(at, at + 1_600)));
  return out;
}

const flat = (ms: number, level: number) => new Int16Array((ms * RATE) / 1000).fill(level);

describe("Endpointer (docs/voice.md: 0.7 s silence, 0.3 s minimum, 15 s maximum)", () => {
  it("learns a loud USB mic room floor and ends speech after the person stops", () => {
    const endpointer = new Endpointer();
    expect(feed(endpointer, flat(1000, 280))).toHaveLength(0); // about -41 dBFS, measured on the Pi
    expect(endpointer.active).toBe(false);
    expect(feed(endpointer, flat(800, 3500))).toHaveLength(0);
    expect(endpointer.active).toBe(true);
    expect(feed(endpointer, flat(900, 280))).toHaveLength(1);
    expect(endpointer.active).toBe(false);
  });

  it("does not turn a sustained -25 dBFS room into a 15 s false clip", () => {
    const activity: boolean[] = [];
    const endpointer = new Endpointer({}, (active) => activity.push(active));
    expect(feed(endpointer, flat(16_000, 1_843))).toHaveLength(0);
    expect(endpointer.active).toBe(false);
    expect(activity).toEqual([]);

    expect(feed(endpointer, flat(600, 9_000))).toHaveLength(0);
    expect(endpointer.active).toBe(true);
    expect(feed(endpointer, flat(900, 1_843))).toHaveLength(1);
    expect(activity).toEqual([true, false]);
  });

  it("still catches speech that begins on the first mic frame", () => {
    expect(feed(new Endpointer(), signal([{ ms: 600, loud: true }, { ms: 900, loud: false }]))).toHaveLength(1);
  });

  it("reports when speech starts and when it ends or is cancelled", () => {
    const activity: boolean[] = [];
    const endpointer = new Endpointer({}, (active) => activity.push(active));
    feed(endpointer, signal([{ ms: 300, loud: false }, { ms: 500, loud: true }, { ms: 800, loud: false }]));
    expect(activity).toEqual([true, false]);
    feed(endpointer, signal([{ ms: 300, loud: false }, { ms: 500, loud: true }]));
    endpointer.reset();
    expect(activity).toEqual([true, false, true, false]);
  });

  it("finds one utterance between silences, with pre-roll and a short tail", () => {
    const segments = feed(new Endpointer(), signal([{ ms: 1_000, loud: false }, { ms: 1_000, loud: true }, { ms: 1_500, loud: false }]));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(segments[0]!.durationMs).toBeLessThanOrEqual(1_550);
  });

  it("waits for 0.7 s of silence before ending", () => {
    const endpointer = new Endpointer();
    expect(feed(endpointer, signal([{ ms: 500, loud: false }, { ms: 800, loud: true }, { ms: 500, loud: false }]))).toHaveLength(0);
    expect(endpointer.active).toBe(true);
    expect(feed(endpointer, signal([{ ms: 400, loud: false }]))).toHaveLength(1);
  });

  it("drops a bump shorter than 0.3 s", () => {
    expect(feed(new Endpointer(), signal([{ ms: 500, loud: false }, { ms: 200, loud: true }, { ms: 1_000, loud: false }]))).toHaveLength(0);
  });

  it("cuts an utterance at 15 s", () => {
    const segments = feed(new Endpointer(), signal([{ ms: 300, loud: false }, { ms: 16_000, loud: true }]));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.durationMs).toBeLessThanOrEqual(15_000);
  });

  it("flush ends an utterance in progress", () => {
    const endpointer = new Endpointer();
    feed(endpointer, signal([{ ms: 300, loud: false }, { ms: 600, loud: true }]));
    expect(endpointer.flush()?.durationMs).toBeGreaterThan(500);
    expect(endpointer.active).toBe(false);
  });

  it("after a Talk press, waits longer than 0.7 s for the first words", () => {
    const endpointer = new Endpointer();
    feed(endpointer, signal([{ ms: 500, loud: false }]));
    endpointer.forceStart();
    expect(feed(endpointer, signal([{ ms: 2_000, loud: false }]))).toHaveLength(0);
    expect(endpointer.active).toBe(true);
    const segments = feed(endpointer, signal([{ ms: 600, loud: true }, { ms: 800, loud: false }]));
    expect(segments).toHaveLength(1);
  });

  it("a Talk press with no speech ends empty after the press window", () => {
    const endpointer = new Endpointer({ pressNoSpeechMs: 1_000 });
    endpointer.forceStart();
    expect(feed(endpointer, signal([{ ms: 1_200, loud: false }]))).toHaveLength(0);
    expect(endpointer.active).toBe(false);
  });
});

class FakeStreamMic implements StreamingMicrophone {
  readonly label = "fake stream";
  readonly simulated = true;
  opens = 0;
  onPcm: ((pcm: Buffer) => void) | null = null;
  onEnd: ((error: Error) => void) | null = null;
  stopped = false;
  start(): never {
    throw new Error("not used");
  }
  stream(onPcm: (pcm: Buffer) => void, onEnd: (error: Error) => void): PcmStream {
    this.opens += 1;
    this.onPcm = onPcm;
    this.onEnd = onEnd;
    this.stopped = false;
    return { stop: () => (this.stopped = true) };
  }
  /** Sends samples as bytes, in odd-sized chunks to test the carry. */
  send(samples: Int16Array): void {
    const bytes = bytesFromInt16(samples);
    for (let at = 0; at < bytes.length; at += 3_201) this.onPcm?.(bytes.subarray(at, at + 3_201));
  }
}

describe("VadListener", () => {
  it("reports speech activity and mic stream availability", () => {
    const mic = new FakeStreamMic();
    const listener = createListener(mic);
    const activity: boolean[] = [];
    const availability: boolean[] = [];
    listener.start(() => {}, (active) => activity.push(active), (available) => availability.push(available));
    expect(availability).toEqual([true]);
    mic.send(signal([{ ms: 300, loud: false }, { ms: 500, loud: true }]));
    expect(activity).toEqual([true]);
    mic.onEnd?.(new Error("disconnected"));
    expect(activity).toEqual([true, false]);
    expect(availability).toEqual([true, false]);
    listener.stop();
  });

  it("is chosen for a streaming mic and turns an utterance into a 16 kHz WAV clip", () => {
    const mic = new FakeStreamMic();
    const listener = createListener(mic);
    expect(listener).toBeInstanceOf(VadListener);
    const clips: Clip[] = [];
    listener.start((clip) => clips.push(clip));
    mic.send(signal([{ ms: 500, loud: false }, { ms: 800, loud: true }, { ms: 1_000, loud: false }]));
    expect(clips).toHaveLength(1);
    const info = readWav(clips[0]!.wav);
    expect(info.sampleRate).toBe(16_000);
    expect(info.pcm.length / 32).toBe(clips[0]!.durationMs);
  });

  it("drops audio while paused and listens again after resume", () => {
    const mic = new FakeStreamMic();
    const listener = createListener(mic);
    const clips: Clip[] = [];
    listener.start((clip) => clips.push(clip));
    mic.send(signal([{ ms: 300, loud: false }, { ms: 500, loud: true }]));
    listener.pause(); // the box starts speaking mid-utterance
    mic.send(signal([{ ms: 800, loud: true }, { ms: 1_000, loud: false }]));
    expect(clips).toHaveLength(0);
    listener.resume();
    mic.send(signal([{ ms: 300, loud: false }, { ms: 600, loud: true }, { ms: 900, loud: false }]));
    expect(clips).toHaveLength(1);
  });

  it("Talk unpauses and endPress sends what was said", () => {
    const mic = new FakeStreamMic();
    const listener = createListener(mic);
    const clips: Clip[] = [];
    listener.start((clip) => clips.push(clip));
    listener.pause();
    listener.pressTalk();
    mic.send(signal([{ ms: 1_000, loud: false }, { ms: 500, loud: true }]));
    listener.endPress();
    expect(clips).toHaveLength(1);
    expect(clips[0]!.durationMs).toBeGreaterThanOrEqual(1_400);
  });

  it("opens the mic again after its stream dies, and stop closes it", async () => {
    const clock = new FakeClock();
    const mic = new FakeStreamMic();
    const listener = createListener(mic, { clock, restartMs: 2_000 });
    listener.start(() => {});
    mic.onEnd?.(new Error("arecord exited (1)"));
    await clock.advance(1_999);
    expect(mic.opens).toBe(1);
    await clock.advance(1);
    expect(mic.opens).toBe(2);
    listener.stop();
    expect(mic.stopped).toBe(true);
    expect(clock.pending).toBe(0);
  });
});

describe("PressListener (file mic, Talk button only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "clara-vad-test-"));
  const write = (name: string, ms: number) => {
    const path = join(dir, name);
    writeFileSync(path, wavFromPcm(Buffer.alloc(ms * 32, 1), 16_000));
    return path;
  };

  it("sends the next file on each press and drops one under 0.3 s", async () => {
    const mic = new FileMicrophone([write("1.wav", 800), write("2.wav", 200)]);
    const listener = createListener(mic, { clock: new FakeClock() });
    expect(listener).toBeInstanceOf(PressListener);
    const clips: Clip[] = [];
    listener.start((clip) => clips.push(clip));
    listener.pressTalk();
    listener.endPress();
    await flush();
    listener.pressTalk();
    listener.endPress();
    await flush();
    expect(clips.map((c) => c.durationMs)).toEqual([800]);
  });

  it("ends a press at 15 s by itself, and a pause throws the press away", async () => {
    const clock = new FakeClock();
    const listener = createListener(new FileMicrophone([write("3.wav", 900)]), { clock });
    const clips: Clip[] = [];
    listener.start((clip) => clips.push(clip));
    listener.pressTalk();
    listener.pause();
    await clock.advance(20_000);
    expect(clips).toHaveLength(0);
    listener.pressTalk();
    await clock.advance(15_000);
    expect(clips).toHaveLength(1);
  });
});

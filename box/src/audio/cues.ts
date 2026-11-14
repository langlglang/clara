// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/audio/wav.ts (CUE_TONES) and devices/pi/src/cues.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CueName } from "../ports.js";
import { toneWav } from "./wav.js";

/**
 * The box's generated cue sounds, each under a second. They are made in memory (no sound files to ship) and
 * piped to the player; only players that need a file (afplay on a Mac) get them written out.
 */
export const CUE_TONES: Record<CueName, ReadonlyArray<{ hz: number; ms: number }>> = {
  /** The mic just opened. */
  listening: [
    { hz: 660, ms: 90 },
    { hz: 880, ms: 110 },
  ],
  /** A clip was sent ("got it"). */
  done: [
    { hz: 880, ms: 90 },
    { hz: 660, ms: 110 },
  ],
  /** Mock SOS opened or changed. A calm rising three-note. */
  sos: [
    { hz: 523, ms: 110 },
    { hz: 659, ms: 110 },
    { hz: 784, ms: 160 },
  ],
  /** Something needs attention (a nearby emergency, a responder message). */
  alert: [
    { hz: 1250, ms: 70 },
    { hz: 0, ms: 50 },
    { hz: 1250, ms: 70 },
  ],
  error: [{ hz: 220, ms: 280 }],
};

export const CUE_NAMES = Object.keys(CUE_TONES) as CueName[];

const cache = new Map<CueName, Buffer>();

/** The cue's WAV bytes (made once, then reused). */
export function cueWav(name: CueName): Buffer {
  let wav = cache.get(name);
  if (!wav) cache.set(name, (wav = toneWav(CUE_TONES[name])));
  return wav;
}

/** Writes every cue WAV into `dir` and returns their paths. */
export function writeCueSounds(dir: string): Record<CueName, string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = {} as Record<CueName, string>;
  for (const name of CUE_NAMES) {
    const path = join(dir, `${name}.wav`);
    writeFileSync(path, cueWav(name));
    paths[name] = path;
  }
  return paths;
}

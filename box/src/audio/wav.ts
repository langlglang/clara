// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/audio/wav.ts.
import type { Clip } from "../ports.js";
import { CLIP_BYTES_PER_MS, CLIP_MAX_PCM_BYTES, CLIP_SAMPLE_RATE } from "./constants.js";

/** 16-bit PCM WAV helpers: the voice clip format (16 kHz mono) and the generated cue sounds. */

export const WAV_HEADER_BYTES = 44;

export function wavFromPcm(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: number;
  pcm: Buffer;
}

/** Reads a RIFF/WAVE file's format and PCM data, walking its chunks (ffmpeg adds a LIST chunk). */
export function readWav(file: Buffer): WavInfo {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "pcm"> | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= file.length) {
      fmt = {
        format: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        sampleRate: file.readUInt32LE(body + 4),
        bitsPerSample: file.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data comes before its format.");
      return { ...fmt, pcm: file.subarray(body, Math.min(file.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data.");
}

/** True for the clip format: 16 kHz mono 16-bit PCM. */
export function isClipFormat(info: Omit<WavInfo, "pcm">): boolean {
  return info.format === 1 && info.sampleRate === CLIP_SAMPLE_RATE && info.channels === 1 && info.bitsPerSample === 16;
}

/** Copies at most 15 s of `pcm` into a new clip; the caller still owns (and wipes) `pcm`. */
export function clipFromPcm(pcm: Buffer): Clip {
  const length = Math.min(pcm.length, CLIP_MAX_PCM_BYTES);
  const capped = pcm.subarray(0, length - (length % 2));
  return { wav: wavFromPcm(Buffer.from(capped), CLIP_SAMPLE_RATE), durationMs: Math.floor(capped.length / CLIP_BYTES_PER_MS) };
}

/** 16-bit little-endian samples from raw bytes (copied, so the caller may wipe its buffer). */
export function int16FromBytes(bytes: Buffer): Int16Array {
  const even = bytes.length - (bytes.length % 2);
  const out = new Int16Array(even / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

/** Little-endian bytes of `samples` (a copy). */
export function bytesFromInt16(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i]!, i * 2);
  return out;
}

/** A short sine sequence with 5 ms fades, so cue sounds don't click. A note with `hz: 0` is a rest. */
export function toneWav(notes: ReadonlyArray<{ hz: number; ms: number }>, sampleRate = CLIP_SAMPLE_RATE, volume = 0.4): Buffer {
  const total = notes.reduce((n, note) => n + Math.round((note.ms / 1000) * sampleRate), 0);
  const pcm = Buffer.alloc(total * 2);
  let at = 0;
  for (const note of notes) {
    const count = Math.round((note.ms / 1000) * sampleRate);
    const fade = Math.max(1, Math.min(Math.round(0.005 * sampleRate), Math.floor(count / 2)));
    for (let i = 0; i < count; i += 1, at += 1) {
      const envelope = note.hz === 0 ? 0 : Math.min(1, i / fade, (count - 1 - i) / fade);
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * note.hz * i) / sampleRate) * envelope * volume * 32767), at * 2);
    }
  }
  return wavFromPcm(pcm, sampleRate);
}

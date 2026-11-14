import { describe, expect, it } from "vitest";
import { CUE_NAMES, cueWav } from "../src/audio/cues.js";
import { CLIP_MAX_MS } from "../src/audio/constants.js";
import { bytesFromInt16, clipFromPcm, int16FromBytes, isClipFormat, readWav, toneWav, wavFromPcm } from "../src/audio/wav.js";

describe("wav helpers", () => {
  it("writes a 16 kHz mono WAV that reads back", () => {
    const pcm = bytesFromInt16(Int16Array.from([0, 1000, -1000, 32767]));
    const info = readWav(wavFromPcm(pcm, 16_000));
    expect(isClipFormat(info)).toBe(true);
    expect(Array.from(int16FromBytes(info.pcm))).toEqual([0, 1000, -1000, 32767]);
  });

  it("skips extra chunks and refuses non-WAV data", () => {
    const wav = wavFromPcm(Buffer.alloc(8), 16_000);
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    expect(readWav(withList).pcm.length).toBe(8);
    expect(() => readWav(Buffer.from("not a wav file at all"))).toThrow(/Not a WAV/);
  });

  it("caps a clip at 15 s and reports its length", () => {
    const clip = clipFromPcm(Buffer.alloc(32 * 16_000 + 1));
    expect(clip.durationMs).toBe(CLIP_MAX_MS);
    expect(readWav(clip.wav).pcm.length).toBe(32 * CLIP_MAX_MS);
    expect(clipFromPcm(Buffer.alloc(32 * 500)).durationMs).toBe(500);
  });

  it("makes tones of the asked length, and every cue is short", () => {
    expect(readWav(toneWav([{ hz: 440, ms: 100 }, { hz: 0, ms: 50 }])).pcm.length).toBe(150 * 32);
    for (const name of CUE_NAMES) {
      const ms = readWav(cueWav(name)).pcm.length / 32;
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(1_000);
    }
  });
});

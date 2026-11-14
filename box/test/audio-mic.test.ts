import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileMicrophone, createMicrophone, isStreaming, piMicrophone, resolveMicFiles } from "../src/audio/mic.js";
import { readWav, wavFromPcm } from "../src/audio/wav.js";
import { fakeSpawn, flush } from "./audio-fakes.js";

describe("CommandMicrophone (arecord)", () => {
  it("records raw 16 kHz mono from arecord and stops it with SIGINT", async () => {
    const { spawn, children } = fakeSpawn(() => {});
    const mic = piMicrophone("plughw:CARD=Device,DEV=0", undefined, spawn);
    expect(isStreaming(mic)).toBe(true);
    const session = mic.start();
    const child = children[0]!;
    expect(child.command).toBe("arecord");
    expect(child.args).toEqual(["-q", "-D", "plughw:CARD=Device,DEV=0", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"]);
    child.stdout.write(Buffer.alloc(32 * 400, 7));
    await flush();
    const clip = await session.stop();
    expect(child.signals[0]).toBe("SIGINT");
    expect(clip.durationMs).toBe(400);
    expect(readWav(clip.wav).pcm[0]).toBe(7);
  });

  it("reports a missing command and an empty recording", async () => {
    const missing = fakeSpawn((child) => setImmediate(() => child.failToStart()));
    await expect(piMicrophone("x", undefined, missing.spawn).start().stop()).rejects.toThrow(/could not start \(ENOENT\)/);
    const empty = fakeSpawn(() => {});
    await expect(piMicrophone("x", undefined, empty.spawn).start().stop()).rejects.toThrow(/recorded nothing/);
  });

  it("streams chunks and reports an unexpected end, but not one it asked for", async () => {
    const { spawn, children } = fakeSpawn(() => {});
    const mic = piMicrophone("x", undefined, spawn);
    const got: number[] = [];
    const ends: string[] = [];
    mic.stream((pcm) => got.push(pcm.length), (error) => ends.push(error.message));
    children[0]!.stdout.write(Buffer.alloc(640));
    await flush();
    children[0]!.exit(1);
    expect(got).toEqual([640]);
    expect(ends).toEqual(["arecord exited (1)."]);

    const stream = mic.stream(() => {}, (error) => ends.push(error.message));
    stream.stop();
    await flush();
    expect(children[1]!.signals).toContain("SIGTERM");
    expect(ends).toHaveLength(1);
  });
});

describe("FileMicrophone", () => {
  const dir = mkdtempSync(join(tmpdir(), "clara-mic-test-"));

  it("refuses a WAV in the wrong format up front", () => {
    const path = join(dir, "stereo.wav");
    writeFileSync(path, wavFromPcm(Buffer.alloc(64), 16_000, 2));
    expect(() => new FileMicrophone([path])).toThrow(/16 kHz mono 16-bit/);
  });

  it("resolves a folder in natural order, skipping hidden files, and cycles through it", async () => {
    const folder = join(dir, "clips");
    mkdirSync(folder);
    for (const [name, ms] of [["10-b.wav", 500], ["2-a.wav", 400], ["._2-a.wav", 100]] as const) {
      writeFileSync(join(folder, name), name.startsWith(".") ? Buffer.from("junk") : wavFromPcm(Buffer.alloc(ms * 32), 16_000));
    }
    expect(resolveMicFiles(folder).map((p) => p.slice(folder.length + 1))).toEqual(["2-a.wav", "10-b.wav"]);
    const mic = createMicrophone({ kind: "file", files: folder });
    expect(isStreaming(mic)).toBe(false);
    const lengths = [];
    for (let i = 0; i < 3; i += 1) lengths.push((await mic.start().stop()).durationMs);
    expect(lengths).toEqual([400, 500, 400]);
  });
});

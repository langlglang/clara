import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cueWav } from "../src/audio/cues.js";
import { createSpeaker, PiSpeaker } from "../src/audio/speaker.js";
import { FakeClock, fakeSpawn, flush, type FakeChild } from "./audio-fakes.js";

const tmpDir = () => mkdtempSync(join(tmpdir(), "clara-speaker-test-"));

describe("PiSpeaker", () => {
  it("pipes the server's WAV into aplay on the configured device", async () => {
    const { spawn, children } = fakeSpawn();
    const speaker = new PiSpeaker({ device: "plughw:CARD=Device,DEV=0", tmpDir: tmpDir(), spawn });
    const wav = Buffer.from("RIFF-test");
    await speaker.playWav(wav).done;
    expect(children[0]!.command).toBe("aplay");
    expect(children[0]!.args).toEqual(["-q", "-D", "plughw:CARD=Device,DEV=0", "-"]);
    expect(children[0]!.stdinData.equals(wav)).toBe(true);
  });

  it("plays a recorded step file", async () => {
    const { spawn, children } = fakeSpawn();
    await createSpeaker({ kind: "pi", device: "default", tmpDir: tmpDir(), spawn }).playFile("/content/audio/en/press.wav").done;
    expect(children[0]!.args).toEqual(["-q", "-D", "default", "/content/audio/en/press.wav"]);
  });

  it("speaks with Piper, text on stdin, then plays the file", async () => {
    const { spawn, children } = fakeSpawn();
    const speaker = new PiSpeaker({ device: "default", piperModel: "/voices/en.onnx", tmpDir: tmpDir(), spawn });
    await speaker.speak("Press firmly on the wound.").done;
    expect(children.map((c) => c.command)).toEqual(["piper", "aplay"]);
    expect(children[0]!.stdinData.toString()).toBe("Press firmly on the wound.");
    expect(children[0]!.args.join(" ")).not.toContain("Press");
    expect(children[1]!.args.at(-1)).toBe(children[0]!.args.at(-1));
  });

  it("falls back to espeak-ng when Piper fails, and uses it alone without a model", async () => {
    const piperFails = fakeSpawn((child: FakeChild) => setImmediate(() => (child.command === "piper" ? child.failToStart() : child.exit(0))));
    const speaker = new PiSpeaker({ device: "default", piperModel: "/voices/en.onnx", espeakVoice: "en", tmpDir: tmpDir(), spawn: piperFails.spawn });
    await speaker.speak("Hello").done;
    expect(piperFails.children.map((c) => c.command)).toEqual(["piper", "espeak-ng", "aplay"]);
    expect(piperFails.children[1]!.args.slice(0, 3)).toEqual(["-v", "en", "--stdin"]);

    const plain = fakeSpawn();
    await new PiSpeaker({ device: "default", tmpDir: tmpDir(), spawn: plain.spawn }).speak("Hello").done;
    expect(plain.children.map((c) => c.command)).toEqual(["espeak-ng", "aplay"]);
  });

  it("stop() kills the current player and skips the rest; a failing player rejects", async () => {
    const { spawn, children } = fakeSpawn(() => {});
    const speaker = new PiSpeaker({ device: "default", tmpDir: tmpDir(), spawn });
    const line = speaker.speak("Long line");
    await flush();
    line.stop();
    await line.done;
    expect(children).toHaveLength(1);
    expect(children[0]!.signals).toContain("SIGTERM");

    const failing = fakeSpawn((child) => setImmediate(() => child.exit(1)));
    await expect(new PiSpeaker({ device: "default", tmpDir: tmpDir(), spawn: failing.spawn }).playWav(Buffer.alloc(4)).done).rejects.toThrow(/aplay exited 1/);
  });

  it("plays generated cues and gives up on a hung cue player", async () => {
    const clock = new FakeClock();
    const { spawn, children } = fakeSpawn(() => {});
    const speaker = new PiSpeaker({ device: "default", tmpDir: tmpDir(), spawn, clock });
    const cue = speaker.playCue("listening");
    const settled = cue.then(() => "ok", (error: Error) => error.message);
    await flush();
    expect(children[0]!.stdinData.equals(cueWav("listening"))).toBe(true);
    await clock.advance(2_000);
    expect(await settled).toMatch(/still running after 2000 ms/);
  });
});

describe("SilentSpeaker", () => {
  it("prints lines and fails a missing step file so the queue can fall back", async () => {
    const printed: string[] = [];
    const speaker = createSpeaker({ kind: "silent", print: (line) => printed.push(line) });
    await speaker.speak("Hi").done;
    await speaker.playCue("done");
    await expect(speaker.playFile(join(tmpDir(), "missing.wav")).done).rejects.toThrow(/missing/);
    expect(printed).toEqual(["Clara (box voice): Hi", "(cue: done)"]);
  });
});

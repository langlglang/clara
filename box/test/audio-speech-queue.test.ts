import { describe, expect, it } from "vitest";
import { createSpeechQueue } from "../src/audio/speech-queue.js";
import { FakeClock, FakeSpeaker, flush } from "./audio-fakes.js";

describe("SpeechQueue", () => {
  it("plays one line at a time, in order", async () => {
    const speaker = new FakeSpeaker();
    const queue = createSpeechQueue(speaker, { clock: new FakeClock() });
    const first = queue.say({ text: "one" });
    const second = queue.say({ text: "two" });
    await flush();
    expect(speaker.lines.map((l) => l.value)).toEqual(["one"]);
    expect(queue.busy).toBe(true);
    speaker.lines[0]!.finish();
    await first;
    await flush();
    expect(speaker.lines.map((l) => l.value)).toEqual(["one", "two"]);
    speaker.lines[1]!.finish();
    await second;
    expect(queue.busy).toBe(false);
  });

  it("prefers a file, then a WAV, and falls back to the box's voice when it fails", async () => {
    const speaker = new FakeSpeaker();
    speaker.auto = true;
    speaker.failKinds.add("file");
    const errors: string[] = [];
    const queue = createSpeechQueue(speaker, { clock: new FakeClock(), onError: (e) => errors.push(e.message) });
    await queue.say({ text: "Press on the wound.", file: "/audio/en/press.wav", wav: Buffer.from("x") });
    await queue.say({ text: "Reply", wav: Buffer.from("w") });
    expect(speaker.lines.map((l) => `${l.kind}:${l.value}`)).toEqual(["file:/audio/en/press.wav", "speak:Press on the wound.", "wav:w"]);
    expect(errors).toEqual(["file failed"]);
  });

  it("stopAll stops the current line and drops the queued ones", async () => {
    const speaker = new FakeSpeaker();
    const queue = createSpeechQueue(speaker, { clock: new FakeClock() });
    const lines = [queue.say({ text: "a" }), queue.say({ text: "b" })];
    await flush();
    queue.stopAll();
    await Promise.all(lines);
    expect(speaker.lines).toHaveLength(1);
    expect(speaker.lines[0]!.stopped).toBe(true);
  });

  it("stops a hung line after the per-line limit and moves on", async () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker();
    const errors: string[] = [];
    const queue = createSpeechQueue(speaker, { clock, lineLimitMs: 5_000, onError: (e) => errors.push(e.message) });
    void queue.say({ text: "hangs" });
    const next = queue.say({ text: "next" });
    await clock.advance(5_000);
    expect(speaker.lines[0]!.stopped).toBe(true);
    expect(errors[0]).toMatch(/still playing after 5000 ms/);
    speaker.lines[1]!.finish();
    await next;
  });

  it("tells listeners when it becomes busy and idle; empty lines are skipped", async () => {
    const speaker = new FakeSpeaker();
    speaker.auto = true;
    const queue = createSpeechQueue(speaker, { clock: new FakeClock() });
    const events: string[] = [];
    queue.onBusy(() => events.push("busy"));
    queue.onIdle(() => events.push("idle"));
    await queue.say({ text: "   " });
    await Promise.all([queue.say({ text: "a" }), queue.say({ text: "b" })]);
    await flush();
    expect(events).toEqual(["busy", "idle"]);
  });
});

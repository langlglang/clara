import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CartesiaSpeaker } from "../src/audio/cartesia-speaker.js";
import type { Speaker, Utterance } from "../src/ports.js";
import { spokenLines } from "../src/session/spoken-lines.js";
import { loadScenario, loadTranslations } from "../src/engine/index.js";
import { fileURLToPath } from "node:url";

const done = (): Utterance => ({ done: Promise.resolve(), stop: () => {} });
function fakeSpeaker() {
  const played: string[] = [];
  const speaker: Speaker = {
    label: "local",
    simulated: false,
    speak: (text) => (played.push(`local:${text}`), done()),
    playWav: (wav) => (played.push(`wav:${wav.subarray(44).toString()}`), done()),
    playFile: (path) => (played.push(`file:${path}`), done()),
    playCue: async () => {},
  };
  return { speaker, played };
}
const wavOf = (text: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.from(text)]);

describe("Cartesia speaker", () => {
  it("says the box's own lines in Clara's Cartesia voice and keeps them for offline use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clara-voice-"));
    const { speaker, played } = fakeSpeaker();
    let online = true;
    const asked: string[] = [];
    const fetchWav = async (text: string, language: string) => (asked.push(`${language}:${text}`), online ? wavOf(`${language}:${text}`) : null);
    let language = "en";
    const s = new CartesiaSpeaker(speaker, { fetchWav, language: () => language, cacheDir: dir });
    await s.speak("Simulated call cancelled.").done;
    expect(played).toEqual(["wav:en:Simulated call cancelled."]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
    // Offline now: the saved line still plays in Clara's voice, even after a restart (a new speaker, same folder).
    online = false;
    const again = new CartesiaSpeaker(speaker, { fetchWav, language: () => language, cacheDir: dir });
    await again.speak("Simulated call cancelled.").done;
    expect(played.at(-1)).toBe("wav:en:Simulated call cancelled.");
    // A line never voiced, while offline: the local voice says it, so the box is never silent.
    await again.speak("Message from Priya: on my way").done;
    expect(played.at(-1)).toBe("local:Message from Priya: on my way");
    // Each language is its own recording.
    online = true;
    language = "es";
    await again.speak("Simulated call cancelled.").done;
    expect(played.at(-1)).toBe("wav:es:Simulated call cancelled.");
  });

  it("stopping while a line is being fetched plays nothing", async () => {
    const { speaker, played } = fakeSpeaker();
    let release!: (wav: Buffer) => void;
    const s = new CartesiaSpeaker(speaker, { fetchWav: () => new Promise((r) => (release = r)), language: () => "en", cacheDir: null });
    const u = s.speak("hello");
    u.stop();
    release(wavOf("hello"));
    await u.done;
    expect(played).toEqual([]);
  });

  it("falls back to the local voice when the server is too slow", async () => {
    const { speaker, played } = fakeSpeaker();
    const s = new CartesiaSpeaker(speaker, { fetchWav: (_t, _l, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), language: () => "en", cacheDir: null, fetchTimeoutMs: 20 });
    await s.speak("Open the box first.").done;
    expect(played).toEqual(["local:Open the box first."]);
  });

  it("prepares lines ahead of time and stops after repeated failures (offline)", async () => {
    const { speaker } = fakeSpeaker();
    let calls = 0;
    const s = new CartesiaSpeaker(speaker, { fetchWav: async () => (calls++, null), language: () => "en", cacheDir: null });
    expect(await s.prepare(Array.from({ length: 10 }, (_, i) => ({ text: `line ${i}`, language: "en" })))).toBe(0);
    expect(calls).toBe(3);
    const ok = new CartesiaSpeaker(speaker, { fetchWav: async (t) => wavOf(t), language: () => "en", cacheDir: null });
    expect(await ok.prepare([{ text: "a", language: "en" }, { text: "a", language: "en" }, { text: "b", language: "es" }])).toBe(2);
  });

  it("lists every fixed line, greeting and step in each language, once", () => {
    const dir = fileURLToPath(new URL("../../content/scenarios/", import.meta.url));
    const scenario = loadScenario(dir + "severe-bleeding.json");
    const lines = spokenLines({ scenarios: [scenario], translations: loadTranslations(dir + "severe-bleeding.json") });
    const texts = lines.map((l) => `${l.language}:${l.text}`);
    expect(texts[0]).toMatch(/^en:I'm Clara/);
    expect(texts).toContain("en:SOS cancelled.");
    expect(texts).toContain("es:SOS cancelado.");
    expect(texts).toContain(`en:${scenario.steps[1]!.text}`);
    expect(texts.some((t) => t.startsWith("es:Primero, asegúrate"))).toBe(true);
    expect(texts).toContain("en:Starting SOS. I can keep helping while the call is prepared.");
    expect(new Set(texts).size).toBe(texts.length);
  });
});

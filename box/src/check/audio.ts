// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/check/devices.ts (the audio part).
import { NOT_A_PI, commandProblem, fail, isLinux, pass, skip, text, type Check, type CheckContext, type CheckLine } from "./core.js";

/** Same format the box records in: 16 kHz mono 16-bit. */
const SAMPLE_RATE = 16_000;
/** How much the microphone check records: 1 s, in memory only, zeroed afterwards. */
export const MIC_TEST_MS = 1000;

export const captureDevice = (ctx: CheckContext) => ctx.env.CLARA_ALSA_CAPTURE ?? "default";
export const playbackDevice = (ctx: CheckContext) => ctx.env.CLARA_ALSA_PLAYBACK ?? "default";

export function arecordArgs(device: string, seconds: number): string[] {
  return ["-q", "-D", device, "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-d", String(seconds)];
}

/** Peak and RMS of 16-bit little-endian PCM. */
export function pcmLevel(pcm: Buffer): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  return { peak, rms: samples ? Math.round(Math.sqrt(sum / samples)) : 0 };
}

export async function micLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("audio", "microphone", NOT_A_PI(ctx));
  const device = captureDevice(ctx);
  const result = await ctx.run("arecord", arecordArgs(device, MIC_TEST_MS / 1000), { timeoutMs: MIC_TEST_MS + 4000 });
  const pcm = result.stdout;
  try {
    const problem = commandProblem("arecord", result);
    if (problem) return fail("audio", "microphone", `${device}: ${problem}`);
    if (pcm.length === 0) return fail("audio", "microphone", `${device}: recorded nothing`);
    const { peak, rms } = pcmLevel(pcm);
    const seconds = (pcm.length / (SAMPLE_RATE * 2)).toFixed(1);
    if (peak === 0) return fail("audio", "microphone", `${device}: ${seconds} s recorded, every sample is 0 (muted? see alsamixer)`);
    return pass("audio", "microphone", `${device}: ${seconds} s recorded, peak ${peak} of 32767, RMS ${rms}`);
  } finally {
    pcm.fill(0);
  }
}

/** The device names `aplay -L` lists: its unindented lines. */
export function alsaNames(output: string): string[] {
  return output.split("\n").filter((line) => line !== "" && !/^\s/.test(line)).map((line) => line.trim());
}

export async function speakerLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("audio", "speaker", NOT_A_PI(ctx));
  const device = playbackDevice(ctx);
  const result = await ctx.run("aplay", ["-L"]);
  const problem = commandProblem("aplay", result);
  if (problem) return fail("audio", "speaker", problem);
  const names = alsaNames(text(result));
  if (names.includes(device)) return pass("audio", "speaker", `${device} is listed by aplay -L`);
  const cards = [...new Set(names.map((n) => /CARD=([^,]+)/.exec(n)?.[1]).filter((c): c is string => !!c))];
  return fail("audio", "speaker", `${device} is not listed by aplay -L (cards: ${cards.join(", ") || "none"}). Is the speaker plugged in?`);
}

/** A short two-note WAV (16 kHz mono 16-bit), made here so the check needs no sound files. */
export function twoNoteWav(): Buffer {
  const notes = [
    { hz: 660, ms: 150 },
    { hz: 880, ms: 150 },
  ];
  const samples = notes.reduce((n, note) => n + Math.round((SAMPLE_RATE * note.ms) / 1000), 0);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const note of notes) {
    const count = Math.round((SAMPLE_RATE * note.ms) / 1000);
    for (let i = 0; i < count; i += 1) {
      const fade = Math.min(1, i / 160, (count - i) / 160);
      wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * note.hz * i) / SAMPLE_RATE) * 0.4 * fade * 32767), offset);
      offset += 2;
    }
  }
  return wav;
}

export function toneCheck(enabled: boolean): Check {
  return {
    name: "audio",
    timeoutMs: 10_000,
    async run(ctx) {
      if (!isLinux(ctx)) return [skip("audio", "test tone", NOT_A_PI(ctx))];
      if (!enabled) return [skip("audio", "test tone", "pass --sound to play one short tone")];
      const device = playbackDevice(ctx);
      const result = await ctx.run("aplay", ["-q", "-D", device, "-"], { input: twoNoteWav() });
      const problem = commandProblem("aplay", result);
      return [problem ? fail("audio", "test tone", `${device}: ${problem}`) : pass("audio", "test tone", `played two rising notes on ${device}: did you hear them?`)];
    },
  };
}

export const micCheck: Check = { name: "audio", timeoutMs: 10_000, run: async (ctx) => [await micLine(ctx)] };
export const speakerCheck: Check = { name: "audio", timeoutMs: 10_000, run: async (ctx) => [await speakerLine(ctx)] };

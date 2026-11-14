import { createCartesiaVoice, type Voice } from "@clara/agent";

/**
 * Clara's one voice for everything the server says out loud: the box's own lines (via /api/boxes/:id/speech), the
 * simulated 911 call page and the Twilio demo call. Cartesia only; there is no robotic fallback here. A line that
 * Cartesia can't voice returns null and the reason is logged (never the text or the key).
 */
export interface ClaraSpeech {
  readonly available: boolean;
  speak(text: string, language: string, sampleRate: SpeechRate, signal?: AbortSignal): Promise<Buffer | null>;
}

/** 8 kHz for phone calls, 16 kHz for the box speaker, 24 kHz for the laptop call page. */
export type SpeechRate = 8_000 | 16_000 | 24_000;

const MAX_CACHED = 400;
const MAX_TEXT = 1_500;
const SPEAK_DEADLINE_MS = 12_000;

export function createSpeech(
  env: { CARTESIA_API_KEY?: string; CARTESIA_VOICE_ID?: string },
  o: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): ClaraSpeech {
  const key = env.CARTESIA_API_KEY?.trim();
  const voiceId = env.CARTESIA_VOICE_ID?.trim();
  const log = o.log ?? ((line: string) => console.log(line));
  let lastLogged = 0;
  const onFailure = (reason: string) => {
    // At most one line every 30 s, so an outage doesn't flood the log.
    if (Date.now() - lastLogged < 30_000) return;
    lastLogged = Date.now();
    log(`[speech] Cartesia couldn't voice a line: ${reason}`);
  };
  const voices = new Map<SpeechRate, Voice>();
  const voice = (rate: SpeechRate) => {
    let v = voices.get(rate);
    if (!v && key) {
      v = createCartesiaVoice({ apiKey: key, sampleRate: rate, onFailure, ...(voiceId ? { voiceId } : {}), ...(o.fetch ? { fetchImpl: o.fetch } : {}) });
      voices.set(rate, v);
    }
    return v ?? null;
  };
  const cache = new Map<string, Buffer>();
  const inFlight = new Map<string, Promise<Buffer | null>>();

  return {
    available: Boolean(key),
    async speak(text, language, sampleRate, signal) {
      const words = text.trim().slice(0, MAX_TEXT);
      const v = voice(sampleRate);
      if (!words || !v) return null;
      const cacheKey = `${sampleRate}|${language}|${words}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        // Refresh its place so often-said lines stay.
        cache.delete(cacheKey);
        cache.set(cacheKey, hit);
        return hit;
      }
      let pending = inFlight.get(cacheKey);
      if (!pending) {
        const deadline = AbortSignal.timeout(SPEAK_DEADLINE_MS);
        pending = v.speak(words, language, signal ? AbortSignal.any([signal, deadline]) : deadline).finally(() => inFlight.delete(cacheKey));
        inFlight.set(cacheKey, pending);
      }
      const wav = await pending;
      if (wav) {
        cache.set(cacheKey, wav);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return wav;
    },
  };
}

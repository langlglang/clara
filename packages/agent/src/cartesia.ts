// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/speech.ts.
/**
 * Cartesia speech-to-text ("ears") and text-to-speech ("voice"). Request shapes follow docs.cartesia.ai:
 * `POST /stt` (multipart, model ink-whisper) and `POST /tts/bytes` (JSON, model sonic-3.6), both with
 * `Cartesia-Version: 2026-08-14`. The session's language is passed through to both (Sophi hard-coded "en").
 * Any failure returns null; the caller has a fixed line or the box's own voice. The clip goes to
 * speech-to-text only; text-to-speech receives only Clara's reply text. Nothing here logs.
 */

const CARTESIA_VERSION = "2026-08-14";
const STT_URL = "https://api.cartesia.ai/stt";
const TTS_URL = "https://api.cartesia.ai/tts/bytes";
export const DEFAULT_STT_MODEL = "ink-whisper";
export const DEFAULT_TTS_MODEL = "sonic-3.6";
/** A stock en-US voice; pass another voice id for another language. */
export const DEFAULT_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
/** Replies are short; these caps keep a bad response from filling memory. */
const SPEECH_MAX_BYTES = 2_000_000;
const STT_RESPONSE_MAX_BYTES = 64_000;
const MAX_HEARD = 1_000;

export interface Ears {
  /** The words in a 16 kHz mono WAV clip: "" when none were made out, null on failure. */
  transcribe(wav: Buffer, language: string, signal: AbortSignal): Promise<string | null>;
}

export interface Voice {
  readonly sampleRate: number;
  /** A mono 16-bit PCM WAV of the text, or null on failure. */
  speak(text: string, language: string, signal: AbortSignal): Promise<Buffer | null>;
}

/** Cartesia takes a bare language code ("en", "ar"), not a region; the code itself is passed through. */
export const cartesiaLanguage = (language: string) => language.split("-")[0]!.toLowerCase();

export function createCartesiaEars({ apiKey, model = DEFAULT_STT_MODEL, fetchImpl = fetch }: { apiKey: string; model?: string; fetchImpl?: typeof fetch }): Ears {
  return {
    async transcribe(wav, language, signal) {
      if (!isRiffWave(wav)) return null;
      try {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "turn.wav");
        form.append("model", model);
        form.append("language", cartesiaLanguage(language));
        const response = await fetchImpl(STT_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "cartesia-version": CARTESIA_VERSION },
          body: form,
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const body = await readCapped(response, STT_RESPONSE_MAX_BYTES);
        if (!body) return null;
        const data = JSON.parse(body.toString("utf8")) as { text?: unknown };
        return typeof data.text === "string" ? data.text.trim().slice(0, MAX_HEARD) : null;
      } catch {
        return null;
      }
    },
  };
}

export function createCartesiaVoice({
  apiKey,
  voiceId = DEFAULT_VOICE_ID,
  model = DEFAULT_TTS_MODEL,
  sampleRate = 16_000,
  fetchImpl = fetch,
  onFailure,
}: {
  apiKey: string;
  voiceId?: string;
  model?: string;
  sampleRate?: number;
  fetchImpl?: typeof fetch;
  /** Why a line wasn't voiced (HTTP status, timeout, bad audio). Never the text or the key. */
  onFailure?: (reason: string) => void;
}): Voice {
  return {
    sampleRate,
    async speak(text, language, signal) {
      try {
        const response = await fetchImpl(TTS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "cartesia-version": CARTESIA_VERSION, "content-type": "application/json" },
          body: JSON.stringify({
            model_id: model,
            transcript: text,
            voice: { id: voiceId },
            output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: sampleRate },
            language: cartesiaLanguage(language),
            generation_config: { speed: 1.5 },
          }),
          signal,
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
          onFailure?.(`Cartesia answered ${response.status}${detail ? `: ${detail}` : ""}`);
          return null;
        }
        const audio = await readCapped(response, SPEECH_MAX_BYTES);
        if (!audio || !isRiffWave(audio)) onFailure?.("Cartesia sent no usable audio");
        return audio && isRiffWave(audio) ? audio : null;
      } catch (error) {
        onFailure?.(signal.aborted ? "timed out" : `request failed (${(error as Error).name})`);
        return null;
      }
    },
  };
}

/** Reads a response body up to `maxBytes`; null when it is larger or missing. */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A RIFF/WAVE header followed by at least some data. */
export function isRiffWave(buffer: Buffer): boolean {
  return buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

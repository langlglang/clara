// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/service.ts (turn(): transcribe, model, fixed lines, voice, time budget).
import { VOICE_TURN_VERSION, actionAllowed, type FixedReason, type TurnRequest, type TurnResponse } from "@clara/contracts";
import { deadline, type Assistant } from "./assistant.js";
import type { Ears, Voice } from "./cartesia.js";

/**
 * One voice turn: words (transcribed when the box sent audio) → the assistant's reply → speech for any reply
 * with words in it. Every stage runs inside the turn budget; anything that fails becomes a fixed line. The log
 * line carries only timings and outcomes, never the transcript, the reply or the audio.
 */

export interface TurnDeps {
  assistant: Assistant | null;
  ears: Ears | null;
  voice: Voice | null;
  /** The whole turn's limit, speech included. */
  budgetMs?: number;
  /** Time kept back for text-to-speech after the model answers. */
  voiceReserveMs?: number;
  log?: (line: string) => void;
}

export const TURN_BUDGET_MS = 8_000;
const STT_MAX_MS = 2_500;
const VOICE_RESERVE_MS = 900;

/** Fixed lines in English; other languages fall back to English until they are written and checked. */
export const FIXED_LINES: Record<FixedReason, string> = {
  not_heard: "I didn't catch that. Tell me again, or tap the step on the screen.",
  no_model: "I can't answer right now. Follow the steps on the screen.",
  timeout: "That took too long. Follow the step on the screen, or tell me again.",
  model_error: "Something went wrong. Follow the step on the screen, or tell me again.",
  invalid_reply: "I didn't catch that. Tell me again, or tap the step on the screen.",
  refusal: "I can't help with that. Follow the steps on the screen.",
};

export async function handleTurn(request: TurnRequest, deps: TurnDeps, receivedAt = Date.now()): Promise<TurnResponse> {
  const budget = deps.budgetMs ?? TURN_BUDGET_MS;
  const left = () => budget - (Date.now() - receivedAt);
  const base = { schema_version: VOICE_TURN_VERSION, client_turn_id: request.client_turn_id } as const;
  const timings = { stt_ms: 0, model_ms: 0, tts_ms: 0 };

  const say = async (reply: string): Promise<TurnResponse["speech"]> => {
    if (!deps.voice || !reply || left() <= 50) return null;
    const started = Date.now();
    const limit = deadline(left());
    try {
      const wav = await deps.voice.speak(reply, request.language, limit.signal);
      return wav ? { mime: "audio/wav", sample_rate: deps.voice.sampleRate, data_base64: wav.toString("base64") } : null;
    } catch {
      return null;
    } finally {
      limit.clear();
      timings.tts_ms = Date.now() - started;
    }
  };
  const log = (response: TurnResponse) =>
    deps.log?.(
      `[turn] input=${request.input.type} answered_by=${response.answered_by} reason=${response.reason ?? "none"} action=${response.action?.name ?? "none"} speech=${response.speech ? "yes" : "no"} stt_ms=${timings.stt_ms} model_ms=${timings.model_ms} tts_ms=${timings.tts_ms} ms=${Date.now() - receivedAt}`,
    );
  const fixed = async (reason: FixedReason, heard: string | null): Promise<TurnResponse> => {
    const reply = FIXED_LINES[reason];
    const response: TurnResponse = { ...base, heard, reply, action: null, answered_by: "fixed", reason, speech: await say(reply) };
    log(response);
    return response;
  };

  // 1. Words.
  let words: string | null;
  if (request.input.type === "text") {
    words = request.input.text.trim();
  } else {
    if (!deps.ears) return fixed("not_heard", null);
    const clip = Buffer.from(request.input.data_base64, "base64");
    const started = Date.now();
    const limit = deadline(Math.min(STT_MAX_MS, left()));
    try {
      words = await deps.ears.transcribe(clip, request.language, limit.signal);
    } catch {
      words = null;
    } finally {
      limit.clear();
      timings.stt_ms = Date.now() - started;
      clip.fill(0);
    }
    words = words?.trim() ?? null;
  }
  if (!words) return fixed("not_heard", null);

  // 2. The reply.
  if (!deps.assistant) return fixed("no_model", words);
  const modelLimit = left() - (deps.voiceReserveMs ?? VOICE_RESERVE_MS);
  if (modelLimit <= 0) return fixed("timeout", words);
  const result = await deps.assistant.reply(request.state, request.language, words, modelLimit).catch(
    (): Awaited<ReturnType<Assistant["reply"]>> => ({ ok: false, reason: "model_error", attempts: 0, ms: 0, model: "unknown" }),
  );
  timings.model_ms = result.ms;
  if (!result.ok) return fixed(result.reason, words);
  const { action } = result.reply;
  // The assistant already checked this; checked again here because acting on an unoffered ID is the one thing that must never happen.
  if (action && !actionAllowed(action, request.state)) return fixed("invalid_reply", words);

  // 3. Speech, only when there are words to say: select_step is spoken by the box's recorded step audio.
  // ask_clarifying with no reply uses the question as written.
  let reply = action?.name === "select_step" ? "" : result.reply.reply;
  if (!reply && action?.name === "ask_clarifying") {
    reply = request.state.questions.find((q) => q.question_id === action.question_id)?.text ?? "";
  }
  const response: TurnResponse = {
    ...base,
    heard: words,
    reply,
    action,
    answered_by: "model",
    reason: null,
    speech: reply ? await say(reply) : null,
  };
  log(response);
  return response;
}

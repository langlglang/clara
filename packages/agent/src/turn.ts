// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/service.ts (turn(): transcribe, model, fixed lines, voice, time budget).
import { VOICE_TURN_VERSION, actionAllowed, fingerCutNeedsClarification, guidedAdvanceAllowed, guidedStartAllowed, minorCutVisualAllowed, visualById, type FixedReason, type TurnRequest, type TurnResponse } from "@clara/contracts";
import { startTriage, TRIAGE_QUESTIONS, type TriageObservations } from "@clara/contracts";

const TAG_WORDS = { red: "red, urgent", yellow: "yellow, can wait a little", green: "green, walking wounded", black: "black" } as const;
/** Fixed words for a triage turn: the next START question, or the tag the rules decided. */
export function triageLine(o: TriageObservations): string {
  const r = startTriage(o);
  return "need" in r ? `Patient ${o.patient}. ${TRIAGE_QUESTIONS[r.need]}` : `Patient ${o.patient} is ${TAG_WORDS[r.tag]}. Tell me about the next person.`;
}
import { deadline, type Assistant } from "./assistant.js";
import type { Ears, Voice } from "./cartesia.js";
import { isObviousNonRequestTranscript } from "./utterance-filter.js";

/**
 * One voice turn: words (transcribed when the box sent audio) → the assistant's reply → speech for any reply
 * with words in it. Every stage runs inside the turn budget; anything that fails becomes a fixed line. The log
 * line carries only timings and outcomes, never the transcript, the reply or the audio.
 */

export interface TurnDeps {
  assistant: Assistant | null;
  ears: Ears | null;
  voice: Voice | null;
  /** Canonical demo content resolver; model and box-supplied text cannot author guidance. */
  guidance?: (scenarioId: string, stepId: string, language: string) => string | null;
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
  not_heard: "I didn't catch that. Please tell me again.",
  no_model: "I can't answer right now. The simulated SOS button is available.",
  timeout: "That took too long. Please tell me again.",
  model_error: "Something went wrong. Please tell me again.",
  invalid_reply: "I didn't catch that. Please tell me again.",
  refusal: "I can't help with that request. The simulated SOS button is available.",
};

/** Spanish fixed lines (draft: to be checked by a fluent speaker). */
export const FIXED_LINES_ES: Record<FixedReason, string> = {
  not_heard: "No te he entendido. Por favor, dímelo otra vez.",
  no_model: "Ahora no puedo responder. El botón de SOS simulado está disponible.",
  timeout: "Eso tardó demasiado. Por favor, dímelo otra vez.",
  model_error: "Algo salió mal. Por favor, dímelo otra vez.",
  invalid_reply: "No te he entendido. Por favor, dímelo otra vez.",
  refusal: "No puedo ayudar con eso. El botón de SOS simulado está disponible.",
};

/** The server's own fixed replies to actions, per language (Spanish is a draft). */
const ACTION_LINES = {
  en: {
    locate: (name: string) => `The screen shows where to find ${name}. Look for the compartment light in the box.`,
    emergencyAnswer: "Got it. You can keep talking with me.",
    nearbyKits: "I'll ask the other Clara boxes nearby to bring their kits.",
    readPulse: "I'll read the pulse sensor now. Keep a finger steady on it while I continue listening.",
    requestCamera: "I'll take one photo and send it to Clara's cloud to describe what I can see. You can keep talking with me.",
    captureCamera: "I'll take and inspect one photo now. You can keep talking with me.",
  },
  es: {
    locate: (name: string) => `La pantalla muestra dónde está ${name}. Busca la luz del compartimento en la caja.`,
    emergencyAnswer: "Entendido. Puedes seguir hablando conmigo.",
    nearbyKits: "Voy a pedir a las otras cajas Clara cercanas que traigan sus kits.",
    readPulse: "Voy a leer el sensor de pulso. Mantén un dedo quieto sobre él mientras sigo escuchando.",
    requestCamera: "Voy a tomar una foto y enviarla a la nube de Clara para describir lo que veo. Puedes seguir hablando conmigo.",
    captureCamera: "Voy a tomar y revisar una foto ahora. Puedes seguir hablando conmigo.",
  },
} as const;

export async function handleTurn(request: TurnRequest, deps: TurnDeps, receivedAt = Date.now(), cancel?: AbortSignal): Promise<TurnResponse> {
  const budget = deps.budgetMs ?? TURN_BUDGET_MS;
  const left = () => budget - (Date.now() - receivedAt);
  const base = { schema_version: VOICE_TURN_VERSION, client_turn_id: request.client_turn_id } as const;
  const timings = { stt_ms: 0, model_ms: 0, tts_ms: 0 };

  const say = async (reply: string): Promise<TurnResponse["speech"]> => {
    if (!deps.voice || !reply || left() <= 50 || cancel?.aborted) return null;
    const started = Date.now();
    const limit = deadline(left());
    try {
      const wav = await deps.voice.speak(reply, request.language, cancel ? AbortSignal.any([limit.signal, cancel]) : limit.signal);
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
  const spanish = request.language.toLowerCase().startsWith("es");
  const lines = spanish ? ACTION_LINES.es : ACTION_LINES.en;
  const fixed = async (reason: FixedReason, heard: string | null, override?: string): Promise<TurnResponse> => {
    const reply = override ?? (spanish ? FIXED_LINES_ES : FIXED_LINES)[reason];
    const response: TurnResponse = { ...base, heard, reply, action: null, answered_by: "fixed", reason, speech: await say(reply) };
    log(response);
    return response;
  };
  const silentNotHeard = (): TurnResponse => {
    const response: TurnResponse = { ...base, heard: null, reply: "", action: null, answered_by: "fixed", reason: "not_heard", speech: null };
    log(response);
    return response;
  };

  // 1. Words.
  let words: string | null;
  if (request.input.type === "text") {
    words = request.input.text.trim();
  } else {
    if (!deps.ears) return silentNotHeard();
    const clip = Buffer.from(request.input.data_base64, "base64");
    const started = Date.now();
    const limit = deadline(Math.min(STT_MAX_MS, left()));
    try {
      words = await deps.ears.transcribe(clip, request.language, cancel ? AbortSignal.any([limit.signal, cancel]) : limit.signal);
    } catch {
      words = null;
    } finally {
      limit.clear();
      timings.stt_ms = Date.now() - started;
      clip.fill(0);
    }
    words = words?.trim() ?? null;
  }
  if (!words || (request.input.type === "audio" && isObviousNonRequestTranscript(words))) {
    return request.input.type === "audio" ? silentNotHeard() : fixed("not_heard", null);
  }
  if (request.state.camera_answer_pending && !request.state.core_context?.camera) {
    return fixed("invalid_reply", words, spanish
      ? "No pude revisar esa foto. Dime qué ves."
      : "I couldn't inspect that photo. Please tell me what you see.");
  }

  // A short acknowledgement in a guide with exactly one offered next panel needs no model decision.
  // This avoids spending the model deadline on "Got it" while preserving model judgement for questions,
  // interruptions, and branching guides. Both the server and Pi still validate the action and text.
  const nextSteps = request.state.allowed_steps.filter((step) => step.step_id !== request.state.step_id);
  if (request.state.guided_active && request.state.scenario_id && nextSteps.length === 1 &&
    /^(?:got it|done|finished|ready|found it|have it|i have it)[.! ]*$/i.test(words)) {
    const action = { name: "select_step", step_id: nextSteps[0]!.step_id } as const;
    const reply = deps.guidance?.(request.state.scenario_id, action.step_id, request.language);
    if (reply && actionAllowed(action, request.state) && guidedAdvanceAllowed(words)) {
      const response: TurnResponse = { ...base, heard: words, reply, action, answered_by: "fixed", reason: null, speech: await say(reply) };
      log(response);
      return response;
    }
  }

  // 2. The reply.
  if (!deps.assistant) return fixed("no_model", words);
  const modelLimit = left() - (deps.voiceReserveMs ?? VOICE_RESERVE_MS);
  if (modelLimit <= 0) return fixed("timeout", words);
  const result = await deps.assistant.reply(request.state, request.language, words, modelLimit, cancel).catch(
    (): Awaited<ReturnType<Assistant["reply"]>> => ({ ok: false, reason: "model_error", attempts: 0, ms: 0, model: "unknown" }),
  );
  timings.model_ms = result.ms;
  if (!result.ok) return fixed(result.reason, words);
  const { action } = result.reply;
  // The assistant already checked this; checked again here because acting on an unoffered ID is the one thing that must never happen.
  if (action && !actionAllowed(action, request.state)) return fixed("invalid_reply", words);
  if (action?.name === "select_step" && request.state.scenario_id === "severe_bleeding" && fingerCutNeedsClarification(words)) {
    return fixed("invalid_reply", words, spanish
      ? "¿Es un corte pequeño y superficial, o sangra mucho?"
      : "Is it a small, shallow cut, or is it bleeding heavily?");
  }
  if (action?.name === "start_guidance" && (!request.language.startsWith("en") || !guidedStartAllowed(words))) return fixed("invalid_reply", words);
  if (action?.name === "start_guidance" && action.scenario_id === "minor_cut" && !minorCutVisualAllowed(words)) return fixed("invalid_reply", words);
  if (action?.name === "select_step" && request.state.guided_active && action.step_id !== request.state.step_id && !guidedAdvanceAllowed(words)) return fixed("invalid_reply", words);

  // 3. Resolve selected guidance against server-owned content, then voice that exact text. The model's
  // selected-step wording is discarded by parseReply; the box also checks this against its local bundle.
  let reply = result.reply.reply;
  if (action?.name === "select_step") {
    reply = (request.state.scenario_id && deps.guidance?.(request.state.scenario_id, action.step_id, request.language)) || "";
    if (!reply) return fixed("invalid_reply", words);
  }
  if (action?.name === "start_guidance") {
    const guide = request.state.guided_scenarios?.find((s) => s.scenario_id === action.scenario_id);
    reply = guide ? deps.guidance?.(guide.scenario_id, guide.start_step_id, request.language) ?? "" : "";
    if (!reply) return fixed("invalid_reply", words);
  }
  if (action?.name === "locate_item" && (spanish || request.language.toLowerCase().startsWith("en"))) {
    const item = request.state.manifest.find((entry) => entry.sku === action.sku);
    if (!item) return fixed("invalid_reply", words);
    reply = lines.locate(item.name);
  }
  if (action?.name === "show_visual") {
    const visual = visualById(action.visual_id);
    if (!visual) return fixed("invalid_reply", words);
    if (visual.id === "minor_cut_rinse_cover" && !minorCutVisualAllowed(words)) return fixed("invalid_reply", words);
    reply = visual.line;
  }
  if (!reply && action?.name === "ask_clarifying") {
    reply = request.state.questions.find((q) => q.question_id === action.question_id)?.text ?? "";
  }
  if (action?.name === "answer_emergency_question") {
    // The model supplies only IDs; the Pi sends this turn's exact heard transcript as the user report.
    reply = lines.emergencyAnswer;
  }
  if (action?.name === "request_nearby_kits") reply = lines.nearbyKits;
  if (action?.name === "assess_patient") reply = triageLine(action.observations);
  if (action?.name === "read_pulse") reply = lines.readPulse;
  if (action?.name === "request_camera") reply = lines.requestCamera;
  if (action?.name === "capture_camera") reply = lines.captureCamera;
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

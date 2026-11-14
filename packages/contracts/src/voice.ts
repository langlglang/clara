// Voice turn contract. First drafted for Clara before the event and adapted from the Sophi device turn contract (github.com/mzhao1599/sophi, packages/contracts).
import { z } from "zod";
import { TriageObservationsSchema } from "./triage.js";

/**
 * Voice turn API, `voice-turn/0.8`. The box sends one turn per utterance; the server answers
 * with what it heard, a short reply and at most one action. See docs/contracts.md and docs/voice.md.
 */
export const VOICE_TURN_VERSION = "voice-turn/0.8";

/** A clip is 16 kHz mono 16-bit PCM WAV: 32 bytes per millisecond. */
export const CLIP_SAMPLE_RATE = 16_000;
export const CLIP_MAX_MS = 15_000;
export const CLIP_MIN_MS = 300;
/** 15 s of audio is 480 KB of samples; base64 adds a third. */
export const CLIP_MAX_BASE64_CHARS = Math.ceil(((CLIP_MAX_MS * 32 + 1_024) * 4) / 3) + 4;
export const MAX_TEXT_INPUT = 500;
export const MAX_REPLY = 250;
export const MAX_HEARD = 1_000;

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);

export const TurnInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("audio"),
    mime: z.literal("audio/wav"),
    data_base64: z.string().min(1).max(CLIP_MAX_BASE64_CHARS),
    duration_ms: z.number().int().min(0).max(CLIP_MAX_MS),
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().trim().min(1).max(MAX_TEXT_INPUT) }),
]);
export type TurnInput = z.infer<typeof TurnInputSchema>;

export const AllowedStepSchema = z.strictObject({ step_id: Id, label: z.string().min(1).max(120) });
export const QuestionSchema = z.strictObject({ question_id: Id, text: z.string().min(1).max(200) });
export const ManifestItemSchema = z.strictObject({ sku: Id, name: z.string().min(1).max(80), on_hand: z.number().int().min(0).max(999) });
export const RecentTurnSchema = z.strictObject({ from: z.enum(["person", "clara"]), words: z.string().max(MAX_HEARD) });
export const AvailableVisualSchema = z.strictObject({ visual_id: Id, label: z.string().min(1).max(80) });
export const GuidedScenarioSchema = z.strictObject({ scenario_id: Id, label: z.string().min(1).max(80), start_step_id: Id });
export const PendingEmergencyQuestionSchema = z.strictObject({ task_id: z.uuid(), question_id: z.enum(["situation", "people_count", "location"]), prompt: z.string().min(1).max(200) });
export const CoreContextSchema = z.strictObject({
  reports: z.array(z.strictObject({ source_event_id: z.uuid(), at: z.iso.datetime({ offset: true }), text: z.string().max(500) })).max(4),
  actions: z.array(z.strictObject({ name: z.enum(["locate_item", "show_visual", "suggest_sos", "read_pulse", "request_camera", "capture_camera"]), id: z.string().max(80).nullable(), status: z.literal("requested"), at: z.iso.datetime({ offset: true }) })).max(6),
  emergency_task: z.strictObject({ task_id: z.uuid(), state: z.enum(["collecting_facts", "facts_ready"]) }).nullable(),
  /** Server-owned, short-lived image-model observation. Never a clinical finding. */
  camera: z.strictObject({ captured_at: z.iso.datetime({ offset: true }), observed_at: z.iso.datetime({ offset: true }), description: z.string().max(1400) }).nullable(),
});

export const TurnStateSchema = z.strictObject({
  scenario_id: Id.nullable(),
  step_id: Id.nullable(),
  allowed_steps: z.array(AllowedStepSchema).max(20),
  questions: z.array(QuestionSchema).max(20),
  manifest: z.array(ManifestItemSchema).max(40),
  triage_available: z.boolean(),
  recent_turns: z.array(RecentTurnSchema).max(12),
  available_visuals: z.array(AvailableVisualSchema).max(12).optional(),
  guided_scenarios: z.array(GuidedScenarioSchema).max(12).optional(),
  guided_active: z.boolean().optional(),
  pending_emergency_question: PendingEmergencyQuestionSchema.optional(),
  pulse_available: z.boolean().optional(),
  camera_available: z.boolean().optional(),
  /** The box is asking Core to answer the question that triggered the last camera frame; no new action. */
  camera_answer_pending: z.boolean().optional(),
  pending_camera_consent: z.literal("cloud_interpretation").optional(),
  /** The box is in SOS and hasn't asked nearby boxes yet: request_nearby_kits may be chosen. */
  nearby_kits_available: z.literal(true).optional(),
  /** Server-owned, source-labeled context. The server ignores a box-supplied value. */
  core_context: CoreContextSchema.optional(),
});
export type TurnState = z.infer<typeof TurnStateSchema>;

export const TurnRequestSchema = z.strictObject({
  schema_version: z.literal(VOICE_TURN_VERSION),
  client_turn_id: z.uuid(),
  session_id: z.uuid(),
  /** BCP 47 language code, for example "en" or "ar". */
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  input: TurnInputSchema,
  state: TurnStateSchema,
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const UsageItemSchema = z.strictObject({ sku: Id, qty: z.number().int().min(1).max(99) });

export const ActionSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("start_guidance"), scenario_id: Id }),
  z.strictObject({ name: z.literal("select_step"), step_id: Id }),
  z.strictObject({ name: z.literal("ask_clarifying"), question_id: Id }),
  z.strictObject({ name: z.literal("locate_item"), sku: Id }),
  z.strictObject({ name: z.literal("record_usage"), items: z.array(UsageItemSchema).min(1).max(10) }),
  z.strictObject({ name: z.literal("start_triage") }),
  z.strictObject({ name: z.literal("assess_patient"), observations: TriageObservationsSchema }),
  z.strictObject({ name: z.literal("suggest_sos") }),
  z.strictObject({ name: z.literal("request_nearby_kits") }),
  z.strictObject({ name: z.literal("show_visual"), visual_id: Id }),
  z.strictObject({ name: z.literal("read_pulse") }),
  z.strictObject({ name: z.literal("request_camera") }),
  z.strictObject({ name: z.literal("capture_camera") }),
  z.strictObject({ name: z.literal("answer_emergency_question"), task_id: z.uuid(), question_id: z.enum(["situation", "people_count", "location"]) }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionName = Action["name"];

/** Conservative English guards for paced guides; the model cannot advance on an unrelated utterance. */
export function guidedStartAllowed(words: string): boolean {
  return !/\b(heavy|severe|spurting|gushing|uncontrolled|unresponsive|unconscious|fainting|not breathing|won't stop|cannot stop)\b/i.test(words);
}

export function guidedAdvanceAllowed(words: string): boolean {
  if (/\b(not|can't|cannot|couldn't|haven't|didn't|still bleeding|worse|worsening)\b/i.test(words)) return false;
  return /\b(done|finished|ready|got it|found it|have it|i am pressing|i'm pressing|pressure is on|bleeding stopped)\b/i.test(words);
}

export const FixedReasonSchema = z.enum(["not_heard", "no_model", "timeout", "model_error", "invalid_reply", "refusal"]);
export type FixedReason = z.infer<typeof FixedReasonSchema>;

export const SpeechSchema = z.strictObject({
  mime: z.literal("audio/wav"),
  sample_rate: z.number().int().positive(),
  data_base64: z.string().min(1).max(2_700_000),
});

export const TurnResponseSchema = z.strictObject({
  schema_version: z.literal(VOICE_TURN_VERSION),
  client_turn_id: z.uuid(),
  heard: z.string().max(MAX_HEARD).nullable(),
  reply: z.string().max(MAX_REPLY + 200),
  action: ActionSchema.nullable(),
  answered_by: z.enum(["model", "fixed"]),
  reason: FixedReasonSchema.nullable(),
  /** Present when Cartesia voiced `reply`; null means the Pi uses local speech for that same text. */
  speech: SpeechSchema.nullable(),
});
export type TurnResponse = z.infer<typeof TurnResponseSchema>;

/**
 * True when every ID the action names was offered in `state`. Both sides call this: the server before
 * answering, the box before acting.
 */
export function actionAllowed(action: Action, state: TurnState): boolean {
  switch (action.name) {
    case "start_guidance":
      return state.guided_scenarios?.some((s) => s.scenario_id === action.scenario_id) ?? false;
    case "select_step":
      return state.allowed_steps.some((s) => s.step_id === action.step_id);
    case "ask_clarifying":
      return state.questions.some((q) => q.question_id === action.question_id);
    case "locate_item":
      return state.manifest.some((m) => m.sku === action.sku);
    case "record_usage":
      return action.items.every((item) => {
        const entry = state.manifest.find((m) => m.sku === item.sku);
        return entry !== undefined && item.qty <= entry.on_hand;
      });
    case "start_triage":
    case "assess_patient":
      return state.triage_available;
    case "suggest_sos":
      return true;
    case "request_nearby_kits":
      return state.nearby_kits_available === true;
    case "show_visual":
      return state.available_visuals?.some((visual) => visual.visual_id === action.visual_id) ?? false;
    case "read_pulse":
      return state.pulse_available === true;
    case "request_camera":
      return state.camera_available === true;
    case "capture_camera":
      return false; // Legacy wire member; the 0.6 flow uses the explicit camera request itself.
    case "answer_emergency_question":
      return state.pending_emergency_question?.task_id === action.task_id && state.pending_emergency_question.question_id === action.question_id;
  }
}

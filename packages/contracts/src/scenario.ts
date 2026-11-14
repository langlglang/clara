import { z } from "zod";

/**
 * A scenario is a fixed, source-linked list of first-aid steps. The model only ever picks a `step_id`
 * from `next` of the current step; it never writes medical instructions itself.
 */

export const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);

export const ScenarioStepSchema = z.strictObject({
  step_id: Id,
  /** Short label shown on buttons and given to the model as the option name. */
  label: z.string().min(1).max(120),
  /** What the screen shows and the recorded audio says. */
  text: z.string().min(1).max(400),
  /** Steps the bystander (or the model) may go to next. Empty means the scenario ends here. */
  next: z.array(Id).max(10),
  /** Kit item this step uses; its compartment lights while the step is shown. */
  item: Id.optional(),
  /** Picture shown with the step (path under content/). */
  image: z.string().max(200).optional(),
  /** Short silent clip that loops while the step is shown (path under content/, .webm or .mp4). Spoken words stay the step's text. */
  video: z.string().max(200).regex(/\.(webm|mp4)$/i).optional(),
  /** Recorded audio per language, for example { "en": "audio/en/pressure.wav" }. */
  audio: z.record(z.string(), z.string().max(200)).optional(),
  /** Showing this step opens the SOS countdown (for example "not breathing"). */
  sos: z.boolean().optional(),
  /** Showing this step starts a timer the scene report keeps (for example the tourniquet). */
  timer: z.enum(["tourniquet", "pressure"]).optional(),
  /** While this step is shown the box coaches a rhythm (CPR: LED beat, metronome tick, compression counter). */
  coach: z.strictObject({ kind: z.literal("cpr"), bpm: z.number().int().min(60).max(160) }).optional(),
});
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const KitItemSchema = z.strictObject({
  sku: Id,
  name: z.string().min(1).max(80),
  /** Physical compartment, for example "B1". */
  slot: Id,
  /** LED channel on the ESP32 for that compartment. */
  led: z.number().int().min(0).max(15),
  on_hand: z.number().int().min(0).max(999),
  /** At or below this count the box reports low supplies. */
  low_at: z.number().int().min(0).max(99).default(0),
});
export type KitItem = z.infer<typeof KitItemSchema>;

/**
 * Demo time-to-care threshold for a scenario: how soon the patient should reach hospital, counted from the SOS.
 * Fictional demo values for the response coordinator's time-to-care check, never medical guidance.
 */
export const CareSchema = z.strictObject({
  reach_hospital_within_min: z.number().int().min(1).max(1440),
  note: z.string().min(1).max(200),
  /** The patient must travel lying down / in a wheelchair (drivers who can't take that are not suitable). */
  needs_lying_down: z.boolean().optional(),
  needs_wheelchair: z.boolean().optional(),
});
export type Care = z.infer<typeof CareSchema>;

export const ScenarioSchema = z.strictObject({
  scenario_id: Id,
  version: z.string().min(1).max(40),
  title: z.string().min(1).max(80),
  /** "draft" until a teammate checked every step against the sources. */
  status: z.enum(["draft", "checked"]),
  /** Offer this source-linked scenario as an optional voice-paced guide. */
  guided: z.boolean().optional(),
  sources: z.array(z.url()).min(1),
  start: Id,
  steps: z.array(ScenarioStepSchema).min(1),
  questions: z.array(z.strictObject({ question_id: Id, text: z.string().min(1).max(200) })).max(20),
  triage_available: z.boolean(),
  /** Optional demo time-to-care threshold (see CareSchema). */
  care: CareSchema.optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * A scenario's words in another language (content/scenarios/<language>/<file>.json). Only words: step order,
 * items, timers and SOS stay with the English scenario, so a translation can never change what the box does.
 * "draft" until a fluent teammate checked it against the English text.
 */
export const ScenarioTranslationSchema = z.strictObject({
  scenario_id: Id,
  language: z.string().regex(/^[a-z]{2,3}$/),
  status: z.enum(["draft", "checked"]),
  title: z.string().min(1).max(80),
  steps: z.record(Id, z.strictObject({ label: z.string().min(1).max(120), text: z.string().min(1).max(400) })),
  questions: z.record(Id, z.string().min(1).max(200)).default({}),
});
export type ScenarioTranslation = z.infer<typeof ScenarioTranslationSchema>;

/** The scenario with a translation's words swapped in. A step or question the translation lacks keeps its English words. */
export function localizeScenario(scenario: Scenario, translation: ScenarioTranslation | null | undefined): Scenario {
  if (!translation || translation.scenario_id !== scenario.scenario_id) return scenario;
  return {
    ...scenario,
    title: translation.title,
    steps: scenario.steps.map((step) => {
      const words = translation.steps[step.step_id];
      return words ? { ...step, label: words.label, text: words.text } : step;
    }),
    questions: scenario.questions.map((q) => ({ ...q, text: translation.questions[q.question_id] ?? q.text })),
  };
}

/** Throws when a step's `next` or `start` names a step that doesn't exist. */
export function checkScenario(scenario: Scenario): Scenario {
  const ids = new Set(scenario.steps.map((s) => s.step_id));
  if (ids.size !== scenario.steps.length) throw new Error(`${scenario.scenario_id}: duplicate step_id`);
  if (!ids.has(scenario.start)) throw new Error(`${scenario.scenario_id}: start "${scenario.start}" is not a step`);
  for (const step of scenario.steps) {
    for (const next of step.next) {
      if (!ids.has(next)) throw new Error(`${scenario.scenario_id}: ${step.step_id} → unknown step "${next}"`);
    }
  }
  return scenario;
}

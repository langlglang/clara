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
  /** Recorded audio per language, for example { "en": "audio/en/pressure.wav" }. */
  audio: z.record(z.string(), z.string().max(200)).optional(),
  /** Showing this step opens the SOS countdown (for example "not breathing"). */
  sos: z.boolean().optional(),
  /** Showing this step starts a timer the scene report keeps (for example the tourniquet). */
  timer: z.enum(["tourniquet", "pressure"]).optional(),
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
  sources: z.array(z.url()).min(1),
  start: Id,
  steps: z.array(ScenarioStepSchema).min(1),
  questions: z.array(z.strictObject({ question_id: Id, text: z.string().min(1).max(200) })).max(20),
  triage_available: z.boolean(),
  /** Optional demo time-to-care threshold (see CareSchema). */
  care: CareSchema.optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

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

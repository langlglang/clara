import { z } from "zod";

/**
 * START triage (Simple Triage And Rapid Treatment), decided in code. The voice agent only extracts what the
 * bystander reported about one patient; this function turns those observations into a tag, or says which single
 * observation is still needed. The model never chooses the tag itself.
 *
 * Order: walks → green. Not breathing → (airway opened) still not breathing → black, breathes → red.
 * Breathing over 30/min → red. No radial pulse or capillary refill over 2 s → red. Can't follow simple
 * commands → red. Otherwise yellow.
 */

export const TriageObservationsSchema = z.strictObject({
  patient: z.number().int().min(1).max(50),
  walks: z.boolean().nullable(),
  breathing: z.boolean().nullable(),
  breathes_after_airway: z.boolean().nullable(),
  breathing_over_30: z.boolean().nullable(),
  /** False when there is no radial pulse or capillary refill is over two seconds. */
  circulation_ok: z.boolean().nullable(),
  follows_commands: z.boolean().nullable(),
});
export type TriageObservations = z.infer<typeof TriageObservationsSchema>;

export type TriageTag = "green" | "yellow" | "red" | "black";
export type TriageNeed = Exclude<keyof TriageObservations, "patient">;

export function startTriage(o: TriageObservations): { tag: TriageTag; because: string } | { need: TriageNeed } {
  if (o.walks === true) return { tag: "green", because: "walks" };
  if (o.walks == null) return { need: "walks" };
  if (o.breathing == null) return { need: "breathing" };
  if (o.breathing === false) {
    if (o.breathes_after_airway == null) return { need: "breathes_after_airway" };
    return o.breathes_after_airway ? { tag: "red", because: "breathes only after the airway was opened" } : { tag: "black", because: "not breathing after the airway was opened" };
  }
  if (o.breathing_over_30 == null) return { need: "breathing_over_30" };
  if (o.breathing_over_30) return { tag: "red", because: "breathing over 30 a minute" };
  if (o.circulation_ok == null) return { need: "circulation_ok" };
  if (!o.circulation_ok) return { tag: "red", because: "no wrist pulse or slow capillary refill" };
  if (o.follows_commands == null) return { need: "follows_commands" };
  return o.follows_commands ? { tag: "yellow", because: "breathing, pulse and responds, but can't walk" } : { tag: "red", because: "can't follow simple commands" };
}

/** The one question Clara asks next for a missing observation (fixed text, not model-written). */
export const TRIAGE_QUESTIONS: Record<TriageNeed, string> = {
  walks: "Can this person get up and walk?",
  breathing: "Is this person breathing?",
  breathes_after_airway: "Tilt their head back and lift the chin. Are they breathing now?",
  breathing_over_30: "Are they breathing very fast, more than one breath every two seconds?",
  circulation_ok: "Can you feel a pulse at the wrist?",
  follows_commands: "Ask them to squeeze your hand. Can they do it?",
};

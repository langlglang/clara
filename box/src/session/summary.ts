import type { BoxEvent } from "@clara/contracts";

/**
 * The on-box handoff summary for whoever walks up (paramedics): MIST-style lines built only from this box's own
 * session events, with fixed templates and no model. Nothing is inferred: what the bystander said is "reported",
 * steps the box guided are listed with the time each was shown, device readings are "observed". Works with no network.
 */

export interface SummaryOptions {
  /** Step label for a scenario step, from the loaded scenarios; the raw id when unknown. */
  stepLabel?: (scenarioId: string, stepId: string) => string | null;
  /** HH:MM for a wall-clock time; defaults to the box's local time. */
  time?: (iso: string) => string;
}

export interface HandoffSummary {
  /** Lines for the handoff card, in MIST order. */
  lines: string[];
  /** The same, as one short paragraph to speak. */
  speech: string;
}

const MAX_REPORTED = 2;
const MAX_STEPS = 6;
const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function buildHandoffSummary(events: readonly BoxEvent[], o: SummaryOptions = {}): HandoffSummary {
  const time = o.time ?? localTime;
  const label = (scenarioId: string, stepId: string) => o.stepLabel?.(scenarioId, stepId) ?? stepId;
  const lines: string[] = [];

  const heard = events.filter((e): e is Extract<BoxEvent, { type: "report.heard" }> => e.type === "report.heard" && e.text.trim() !== "");
  if (heard.length > 0) {
    const said = heard.slice(0, MAX_REPORTED).map((e) => `"${clip(e.text, 90)}"`).join(" ");
    lines.push(`Reported by bystander: ${said}`);
  } else lines.push("Reported: nothing recorded.");

  const sos = events.find((e) => e.type === "sos.opened");
  if (sos) lines.push(`Simulated SOS opened at ${time(sos.occurred_at)}.`);

  // Steps: the first time each step was shown on the box, in order.
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const e of events) {
    if (e.type !== "step.shown") continue;
    const key = `${e.scenario_id}/${e.step_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(`${label(e.scenario_id, e.step_id)} at ${time(e.occurred_at)}`);
  }
  if (steps.length > 0) {
    const shown = steps.slice(-MAX_STEPS);
    lines.push(`Steps guided on the box: ${shown.join("; ")}.`);
  } else lines.push("Steps guided: none recorded.");

  const tourniquet = events.find((e) => e.type === "timer.started" && e.timer === "tourniquet");
  if (tourniquet) lines.push(`Tourniquet time: ${time(tourniquet.occurred_at)}.`);

  const pulse = [...events].reverse().find((e): e is Extract<BoxEvent, { type: "sensor.pulse" }> => e.type === "sensor.pulse" && e.bpm !== null && e.quality === "valid");
  if (pulse) lines.push(`Device pulse reading: ${pulse.bpm} per minute at ${time(pulse.occurred_at)}.`);

  return { lines, speech: `Handoff summary. ${lines.join(" ")}` };
}

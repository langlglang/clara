import { LIMITS, type ToolResult } from "./tools.js";
import type { PlanItem } from "./types.js";
import type { RunInput, Runner } from "./runner.js";

/**
 * The deterministic "rules" planner: same tool layer and limits as the deep agent, no LLM. Runs when
 * CLARA_COORDINATOR=rules so the console's coordinator panel is demonstrable without an API key.
 */

/** An alert counts as unanswered after this long with no reply. */
export const UNANSWERED_S = 45;
const MEDICAL = new Set(["doctor", "nurse", "emt", "midwife"]);
const SKILL_WORD: Record<string, string> = { doctor: "doctor", nurse: "nurse", emt: "EMT", midwife: "midwife", stop_the_bleed: "Stop the Bleed", first_aid: "first aid", cpr: "CPR" };

interface AlertRow {
  volunteer_id: string;
  name: string;
  state: string;
  seconds_since_sent: number;
}
interface CandidateRow {
  volunteer_id: string;
  name: string;
  skills: string[];
  matching_skills: string[];
  distance_km: number;
  eta_minutes: number;
}
interface KitRow {
  box_id: string;
  name: string;
  distance_km: number;
  requestable: boolean;
  status: string;
}
interface Incident {
  ok: true;
  need: string;
  open: boolean;
  escalation: { level: string; flag: string | null };
  alerts: AlertRow[];
  extra_alerts_left: number;
  box: { name: string } | null;
  summary: { tourniquet: string | null } | null;
}

const ok = <T>(r: ToolResult): T | null => (r.ok ? (r as unknown as T) : null);

/** Best people to add: anyone with a medical skill within twice the fastest ETA goes first. */
export function pickCandidates(candidates: CandidateRow[], n: number): CandidateRow[] {
  if (n <= 0 || candidates.length === 0) return [];
  const fastest = candidates[0]!.eta_minutes;
  const medical = candidates.filter((c) => c.skills.some((s) => MEDICAL.has(s)) && c.eta_minutes <= Math.max(fastest * 2, fastest + 5));
  const rest = candidates.filter((c) => !medical.includes(c));
  return [...medical, ...rest].slice(0, n);
}

export const describeCandidate = (c: CandidateRow) => {
  const skill = c.skills.find((s) => MEDICAL.has(s)) ?? c.matching_skills[0] ?? c.skills[0] ?? "";
  return `${c.name} (${SKILL_WORD[skill] ?? skill}, ${c.distance_km} km)`;
};

export const rulesRunner: Runner = async (input: RunInput) => {
  const { tools } = input;
  const scout = input.toolsFor("rules");
  const plan: PlanItem[] = [
    { content: "Read the incident, alerts and escalation", status: "in_progress" },
    { content: "Check who declined or hasn't answered", status: "pending" },
    { content: "Alert more responders if nobody is coming", status: "pending" },
    { content: "Check nearby kits for a second kit", status: "pending" },
    { content: "Check whether a ride to hospital is needed", status: "pending" },
    { content: "Post a status note for dispatch", status: "pending" },
  ];
  const step = (i: number) => {
    for (let j = 0; j < plan.length; j++) plan[j]!.status = j < i ? "completed" : j === i ? "in_progress" : "pending";
    input.setPlan(plan.map((p) => ({ ...p })));
  };
  step(0);

  const incident = ok<Incident>(tools.get_incident("rules"));
  if (!incident || !incident.open) {
    plan.forEach((p) => (p.status = "completed"));
    input.setPlan(plan);
    return;
  }
  step(1);
  const coming = incident.alerts.filter((a) => a.state === "coming" || a.state === "arrived");
  const declined = incident.alerts.filter((a) => a.state === "declined" || a.state === "expired");
  const silent = incident.alerts.filter((a) => (a.state === "sent" || a.state === "shown") && a.seconds_since_sent >= UNANSWERED_S);
  const why: string[] = [];
  if (declined.length) why.push(`${declined.map((a) => a.name).join(", ")} declined`);
  if (silent.length && coming.length === 0) why.push(`${silent.map((a) => a.name).join(", ")} no answer ${UNANSWERED_S}+ s`);
  if (incident.alerts.length === 0) why.push("nobody alerted yet");
  const done: string[] = [];

  step(2);
  const candidates = ok<{ candidates: CandidateRow[] }>(scout.list_candidates("rules"))?.candidates ?? [];
  if (coming.length === 0 && why.length > 0) {
    const room = Math.min(LIMITS.ALERTS_PER_CALL, incident.extra_alerts_left, Math.max(1, declined.length + silent.length));
    const picks = pickCandidates(candidates, room);
    if (picks.length) {
      const r = tools.alert_volunteers({ volunteer_ids: picks.map((c) => c.volunteer_id), reason: why.join("; ") }, "rules");
      if (r.ok) done.push(`alerted ${picks.map(describeCandidate).join(", ")}`);
    }
  }

  step(3);
  const kits = ok<{ kits: KitRow[]; incident_box: { low_items: string[] } }>(input.toolsFor("rules").get_nearby_kits("rules"));
  if (kits) {
    const needKit = kits.incident_box.low_items.length > 0 || (coming.length === 0 && incident.escalation.level !== "first");
    const kit = kits.kits.find((k) => k.requestable);
    if (needKit && kit) {
      const reason = kits.incident_box.low_items.length ? `${incident.box?.name ?? "The box"} is low on ${kits.incident_box.low_items.join(", ")}` : "Nobody coming yet; a second kit and its carrier can help";
      const r = tools.request_kit({ from_box_id: kit.box_id, reason }, "rules");
      if (r.ok) done.push(`asked ${kit.name} for its kit`);
    }
  }

  step(4);
  const rides = ok<{ available: boolean; ride: { state: string; suggested: { driver_id: string; name: string; pickup_minutes: number } | null } | null; proposals: unknown[] }>(tools.get_rides("rules"));
  if (rides?.available && incident.summary?.tourniquet && rides.proposals.length === 0 && rides.ride?.state !== "accepted") {
    // A tourniquet means hospital care is needed; propose the ride plan's suggested driver (dispatcher approves).
    // An empty driver_id means "the ride plan's suggested driver" (the plan opens if there is none yet).
    const r = tools.propose_ride({ driver_id: rides.ride?.suggested?.driver_id ?? "", reason: "Tourniquet on: patient needs hospital care; closest free driver" }, "rules");
    const proposed = ok<{ proposed: { name: string } }>(r);
    if (proposed) done.push(`proposed ${proposed.proposed.name} as driver (needs your approval)`);
  }

  const flagReason =
    incident.escalation.flag === "no_reply"
      ? "No reply after everyone with the skill was alerted. Call for help another way."
      : incident.escalation.flag === "nobody_matched" || (coming.length === 0 && candidates.length === 0 && incident.alerts.every((a) => a.state === "declined" || a.state === "expired"))
        ? "Nobody left to alert nearby. Find help another way."
        : null;
  if (flagReason) tools.flag_for_dispatcher({ reason: flagReason }, "rules");

  step(5);
  const status = coming.length
    ? `${coming.map((a) => a.name).join(", ")} ${coming.length === 1 ? "is" : "are"} responding.`
    : `Nobody has accepted yet (${incident.escalation.level} wave).`;
  const text = `Run ${input.run}: ${status}${why.length ? ` ${why.join("; ")}.` : ""}${done.length ? ` Did: ${done.join("; ")}.` : " No action needed."}`;
  const last = input.state.log.notes.at(-1)?.text.replace(/^Run \d+: /, "");
  if (last !== text.replace(/^Run \d+: /, "")) tools.post_dispatch_note({ text: text.slice(0, LIMITS.NOTE_MAX_CHARS) }, "rules");
  plan.forEach((p) => (p.status = "completed"));
  input.setPlan(plan.map((p) => ({ ...p })));
};

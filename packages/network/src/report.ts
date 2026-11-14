import { comingLine, type BoxEvent, type Incident } from "@clara/contracts";
import type { IncidentEntry, Store, StoredEvent } from "./store.js";

/**
 * The EMS scene report (feature 13): a view of the incident's box events and nothing else. Every line cites the
 * event_ids it came from and carries a label: `reported` (what the bystander said or chose), `observed` (what a
 * device read or saw) or `done` (an action taken on the box). checkReport() verifies each line against the log,
 * and buildSceneReport() refuses to return a report that fails it.
 */

export type ReportLabel = "reported" | "observed" | "done";

export interface ReportLine {
  text: string;
  label: ReportLabel;
  /** When it happened, by the box's clock (the cited event's occurred_at). */
  at: string;
  event_ids: string[];
}

export interface ResponderLine {
  text: string;
  state: "coming" | "arrived";
  eta_minutes: number | null;
  /** Network facts cite the volunteer's alert, not a box event. */
  alert_id: string;
}

export interface SceneReport {
  incident_id: string;
  box: { box_id: string; name: string; directions: string };
  need: Incident["need"];
  opened_at: string;
  closed: Incident["closed"];
  /** Always shown: Clara never places a real call. */
  notice: string;
  mist: { mechanism: ReportLine[]; injuries: ReportLine[]; signs: ReportLine[]; treatment: ReportLine[] };
  /** When the box started its first tourniquet guidance timer; this does not confirm application. */
  tourniquet: ReportLine | null;
  timeline: ReportLine[];
  triage: ReportLine[];
  supplies_used: ReportLine[];
  photos: ReportLine[];
  responders: ResponderLine[];
  /** The same template the box speaks; null until someone accepted. */
  coming_line: string | null;
}

export interface ReportOptions {
  /** Time zone for clock times like "2:14 PM". */
  timeZone?: string;
  /** Approved display names for step ids (from the scenario content); otherwise the id, humanized. */
  stepLabels?: Readonly<Record<string, string>>;
  scenarioLabels?: Readonly<Record<string, string>>;
}

export const SIMULATION_NOTICE = "Clara proof of concept. The 911 call shown on the box is a simulation; no emergency number was dialed.";

export function clockTime(iso: string, timeZone = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso)).replace(/\s/g, " ");
}

const humanize = (id: string) => id.replace(/[_.:-]+/g, " ").trim();

/** The incident's events: its lid session (plus the SOS itself), oldest first, heartbeats left out. */
export function incidentEvents(store: Store, entry: IncidentEntry): BoxEvent[] {
  const { incident } = entry;
  return store
    .eventsForBox(incident.box_id)
    .filter(({ event }) => event.type !== "box.heartbeat" && (event.event_id === entry.sos_event_id || (event.session_id !== null && event.session_id === incident.session_id)))
    .sort((a: StoredEvent, b: StoredEvent) => Date.parse(a.event.occurred_at) - Date.parse(b.event.occurred_at) || a.seq - b.seq)
    .map((e) => e.event);
}

/** One timeline line per event, or null for events the timeline leaves out. */
function timelineLine(e: BoxEvent, opts: ReportOptions): ReportLine | null {
  const t = clockTime(e.occurred_at, opts.timeZone);
  const line = (text: string, label: ReportLabel): ReportLine => ({ text: `${t} ${text}`, label, at: e.occurred_at, event_ids: [e.event_id] });
  const step = (id: string) => opts.stepLabels?.[id] ?? humanize(id);
  switch (e.type) {
    case "box.opened":
      return line("Box opened", "observed");
    case "box.closed":
      return line("Box closed", "observed");
    case "scenario.started":
      return line(`Guide started: ${opts.scenarioLabels?.[e.scenario_id] ?? humanize(e.scenario_id)}`, "done");
    case "step.shown":
      return line(`Screen showed step: ${step(e.step_id)}`, "observed");
    case "step.done":
      return line(`Guide advanced past: ${step(e.step_id)}`, "done");
    case "timer.started":
      return line(e.timer === "tourniquet" ? "Tourniquet timer started" : "Direct pressure timer started", "done");
    case "report.heard":
      return line(`Bystander said: "${e.text}"`, "reported");
    case "sos.countdown":
      return line(`SOS countdown started (${e.seconds} s)`, "done");
    case "sos.cancelled":
      return line("SOS cancelled", "done");
    case "sos.opened":
      return line(`Mock SOS opened, need: ${e.need} (simulated 911 call shown)`, "done");
    case "emergency.context":
    case "emergency.answer":
      // Caller-task metadata stays out of the scene report; the cited user report is already on its timeline.
      return null;
    case "supply.used":
      return e.confirmed ? line(`Used: ${humanize(e.sku)} x ${e.qty}`, "done") : null;
    case "sensor.pulse":
      return line(pulseText(e), "observed");
    case "photo.taken":
      return line(`Photo taken: ${e.purpose}`, "done");
    case "triage.tagged":
      return line(`Patient ${e.patient} tagged ${e.tag}`, "done");
    case "box.heartbeat":
      return null;
  }
}

function pulseText(e: Extract<BoxEvent, { type: "sensor.pulse" }>): string {
  if (e.quality === "unavailable" || e.bpm === null) return "Pulse unavailable (device reading)";
  return `Pulse ${e.bpm} bpm (device reading${e.quality === "suspect" ? ", suspect" : ""})`;
}

export function buildSceneReport(store: Store, entry: IncidentEntry, opts: ReportOptions = {}): SceneReport {
  const { incident } = entry;
  const box = store.getBox(incident.box_id);
  const events = incidentEvents(store, entry);
  const t = (e: BoxEvent) => clockTime(e.occurred_at, opts.timeZone);
  const cite = (e: BoxEvent, text: string, label: ReportLabel): ReportLine => ({ text, label, at: e.occurred_at, event_ids: [e.event_id] });
  const mechanism: ReportLine[] = [];
  const injuries: ReportLine[] = [];
  const signs: ReportLine[] = [];
  const treatment: ReportLine[] = [];
  const supplies: ReportLine[] = [];
  const photos: ReportLine[] = [];
  const latestTag = new Map<number, Extract<BoxEvent, { type: "triage.tagged" }>>();

  for (const e of events) {
    switch (e.type) {
      case "report.heard":
        mechanism.push(cite(e, `Bystander reported: "${e.text}" (${t(e)})`, "reported"));
        break;
      case "sos.opened":
        injuries.push(cite(e, `Need chosen at SOS: ${e.need}`, "reported"));
        break;
      case "sensor.pulse":
        signs.push(cite(e, `${pulseText(e)} ${t(e)}`, "observed"));
        break;
      case "timer.started":
        treatment.push(cite(e, `${e.timer === "tourniquet" ? "Tourniquet timer started" : "Direct pressure timer started"} ${t(e)}`, "done"));
        break;
      case "supply.used":
        if (e.confirmed) supplies.push(cite(e, `${humanize(e.sku)} x ${e.qty}`, "done"));
        break;
      case "photo.taken":
        photos.push(cite(e, `Photo ${e.photo_id}: ${e.purpose} (${t(e)})`, "done"));
        break;
      case "triage.tagged":
        latestTag.set(e.patient, e);
        break;
      default:
        break;
    }
  }

  const tq = events.find((e) => e.type === "timer.started" && e.timer === "tourniquet");
  const responders: ResponderLine[] = incident.alerts
    .filter((a): a is typeof a & { state: "coming" | "arrived" } => a.state === "coming" || a.state === "arrived")
    .map((a) => ({
      text: a.state === "arrived" ? `${a.volunteer_name} arrived` : `${a.volunteer_name} is coming${a.eta_minutes === null ? "" : `, about ${Math.max(1, a.eta_minutes)} min`}`,
      state: a.state,
      eta_minutes: a.eta_minutes,
      alert_id: a.alert_id,
    }));

  const report: SceneReport = {
    incident_id: incident.incident_id,
    box: { box_id: incident.box_id, name: box?.box.name ?? incident.box_id, directions: box?.box.directions ?? "" },
    need: incident.need,
    opened_at: incident.opened_at,
    closed: incident.closed,
    notice: SIMULATION_NOTICE,
    mist: { mechanism, injuries, signs, treatment },
    tourniquet: tq ? cite(tq, `Tourniquet timer started ${t(tq)}`, "done") : null,
    timeline: events.map((e) => timelineLine(e, opts)).filter((l): l is ReportLine => l !== null),
    triage: [...latestTag.values()].sort((a, b) => a.patient - b.patient).map((e) => cite(e, `Patient ${e.patient}: ${e.tag} (${t(e)})`, "done")),
    supplies_used: supplies,
    photos,
    responders,
    coming_line: comingLine(incident.alerts),
  };

  const problems = checkReport(report, events, opts);
  if (problems.length > 0) throw new Error(`Scene report failed its check: ${problems.join("; ")}`);
  return report;
}

export function allReportLines(report: SceneReport): ReportLine[] {
  return [
    ...report.mist.mechanism,
    ...report.mist.injuries,
    ...report.mist.signs,
    ...report.mist.treatment,
    ...(report.tourniquet ? [report.tourniquet] : []),
    ...report.timeline,
    ...report.triage,
    ...report.supplies_used,
    ...report.photos,
  ];
}

/**
 * The honesty check: every line cites at least one event in the log, its time is a cited event's time, and every
 * number in its text appears in a cited event (or that event's clock time). Returns the problems found.
 */
/** Numbers the templates themselves contain ("simulated 911 call"). */
const TEMPLATE_NUMBERS = ["911"];

export function checkReport(report: SceneReport, events: readonly BoxEvent[], opts: ReportOptions = {}): string[] {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const problems: string[] = [];
  for (const line of allReportLines(report)) {
    if (line.event_ids.length === 0) {
      problems.push(`no source: ${line.text}`);
      continue;
    }
    const cited = line.event_ids.map((id) => byId.get(id));
    if (cited.some((e) => e === undefined)) {
      problems.push(`unknown source: ${line.text}`);
      continue;
    }
    const sources = cited as BoxEvent[];
    if (!sources.some((e) => e.occurred_at === line.at)) problems.push(`time not from a source: ${line.text}`);
    const allowed = new Set<string>(TEMPLATE_NUMBERS);
    for (const { event_id: _e, session_id: _s, box_id: _b, occurred_at: _o, ...facts } of sources) {
      for (const [n] of JSON.stringify(facts).matchAll(/\d+/g)) allowed.add(n);
    }
    for (const e of sources) for (const [n] of clockTime(e.occurred_at, opts.timeZone).matchAll(/\d+/g)) allowed.add(n);
    for (const [n] of line.text.matchAll(/\d+/g)) if (!allowed.has(n)) problems.push(`number ${n} not in its source: ${line.text}`);
  }
  return problems;
}

import { describe, expect, it } from "vitest";
import { allReportLines, checkReport, incidentEvents, type SceneReport } from "../src/index.js";
import { batch, boxEvents, harness } from "./helpers.js";

function scene() {
  const h = harness();
  const ev = boxEvents("box-clinic");
  const other = boxEvents("box-clinic"); // an earlier, unrelated session on the same box
  const events = [
    other.make("report.heard", h.at(-3_600_000), { text: "Someone twisted an ankle yesterday" }),
    ev.make("box.opened", h.at(), {}),
    ev.make("report.heard", h.at(20_000), { text: "He cut his leg on the fence, it's bleeding a lot" }),
    ev.make("scenario.started", h.at(25_000), { scenario_id: "severe_bleeding", source: "voice" }),
    ev.make("step.shown", h.at(30_000), { scenario_id: "severe_bleeding", step_id: "apply_pressure", source: "voice" }),
    ev.make("timer.started", h.at(40_000), { timer: "pressure", step_id: "apply_pressure" }),
    ev.make("sos.countdown", h.at(50_000), { seconds: 5, source: "touch" }),
    ev.make("sos.opened", h.at(55_000), { need: "bleeding", source: "system" }),
    ev.make("sensor.pulse", h.at(120_000), { bpm: 112, quality: "valid" }),
    ev.make("sensor.pulse", h.at(130_000), { bpm: null, quality: "unavailable" }),
    ev.make("timer.started", h.at(14 * 60_000), { timer: "tourniquet", step_id: "apply_tourniquet" }),
    ev.make("step.done", h.at(14 * 60_000 + 5_000), { scenario_id: "severe_bleeding", step_id: "apply_tourniquet", source: "touch" }),
    ev.make("supply.used", h.at(15 * 60_000), { sku: "tourniquet", qty: 1, confirmed: true }),
    ev.make("supply.used", h.at(15 * 60_000), { sku: "gauze", qty: 7, confirmed: false }),
    ev.make("triage.tagged", h.at(16 * 60_000), { patient: 1, tag: "yellow" }),
    ev.make("triage.tagged", h.at(17 * 60_000), { patient: 1, tag: "red" }),
    ev.make("photo.taken", h.at(18 * 60_000), { photo_id: "ph_1", purpose: "wound" }),
  ];
  const r = h.net.ingest(batch(...events));
  if (!r.ok) throw new Error(r.error);
  const incident = r.opened[0]!;
  const a = incident.alerts.find((x) => x.volunteer_id === "vol-amina")!;
  h.net.respond(a.alert_id, "vol-amina", "coming");
  return { h, ev, events, incident, report: h.net.report(incident.incident_id)! };
}

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe("EMS scene report", () => {
  it("builds MIST from the events, with labels", () => {
    const { report } = scene();
    expect(report.mist.mechanism).toEqual([expect.objectContaining({ label: "reported", text: `Bystander reported: "He cut his leg on the fence, it's bleeding a lot" (2:00 PM)` })]);
    expect(texts(report.mist.injuries)).toEqual(["Need chosen at SOS: bleeding"]);
    expect(report.mist.injuries.every((l) => l.label === "reported")).toBe(true);
    expect(texts(report.mist.signs)).toEqual(["Pulse 112 bpm (device reading) 2:02 PM", "Pulse unavailable (device reading) 2:02 PM"]);
    expect(report.mist.signs.every((l) => l.label === "observed")).toBe(true);
    expect(texts(report.mist.treatment)).toEqual(["Direct pressure timer started 2:00 PM", "Tourniquet timer started 2:14 PM"]);
    expect(report.mist.treatment.every((l) => l.label === "done")).toBe(true);
    expect(report.tourniquet?.text).toBe("Tourniquet timer started 2:14 PM");
    expect(texts(report.timeline)).toContain("2:14 PM Guide advanced past: apply tourniquet");
    expect(texts(report.timeline)).toContain("2:00 PM Mock SOS opened, need: bleeding (simulated 911 call shown)");
    expect(JSON.stringify(report)).not.toMatch(/tourniquet applied|tourniquet on|direct pressure started/i);
    expect(report.notice).toMatch(/simulation/);
  });

  it("lists confirmed supplies, the latest triage tag per patient, photos and who is coming", () => {
    const { report } = scene();
    expect(texts(report.supplies_used)).toEqual(["tourniquet x 1"]); // the unconfirmed gauze is left out
    expect(texts(report.triage)).toEqual(["Patient 1: red (2:17 PM)"]);
    expect(texts(report.photos)).toEqual(["Photo ph_1: wound (2:18 PM)"]);
    expect(report.responders).toEqual([expect.objectContaining({ text: "Amina is coming, about 3 min", state: "coming" })]);
    expect(report.coming_line).toBe("Amina is coming, about 3 minutes.");
  });

  it("every line cites an event of this incident, and nothing from outside it", () => {
    const { h, events, incident, report } = scene();
    const own = new Set(incidentEvents(h.net.store, h.net.store.getIncident(incident.incident_id)!).map((e) => e.event_id));
    const lines = allReportLines(report);
    expect(lines.length).toBeGreaterThan(15);
    for (const line of lines) {
      expect(line.event_ids.length).toBeGreaterThan(0);
      for (const id of line.event_ids) expect(own.has(id)).toBe(true);
      expect(events.find((e) => e.event_id === line.event_ids[0])!.occurred_at).toBe(line.at);
    }
    expect(JSON.stringify(report)).not.toContain("twisted an ankle"); // the other session
    expect(checkReport(report, [...own].map((id) => events.find((e) => e.event_id === id)!))).toEqual([]);
    // Timeline: one line per event except heartbeats and unconfirmed supplies, in time order.
    expect(report.timeline).toHaveLength(own.size - 1);
    expect(report.timeline.map((l) => l.at)).toEqual([...report.timeline.map((l) => l.at)].sort());
  });

  it("the check catches invented facts", () => {
    const { h, incident, report } = scene();
    const events = incidentEvents(h.net.store, h.net.store.getIncident(incident.incident_id)!);
    const tamper = (fn: (r: SceneReport) => void) => {
      const copy: SceneReport = structuredClone(report);
      fn(copy);
      return checkReport(copy, events);
    };
    expect(tamper((r) => (r.mist.signs[0]!.text = "Pulse 140 bpm (device reading) 2:02 PM"))).toHaveLength(1);
    expect(tamper((r) => (r.mist.signs[0]!.event_ids = []))).toHaveLength(1);
    expect(tamper((r) => (r.mist.signs[0]!.event_ids = ["not-an-event"]))).toHaveLength(1);
    expect(tamper((r) => (r.mist.treatment[1]!.at = new Date().toISOString()))).toHaveLength(1);
    expect(tamper((r) => r.mist.signs.push({ text: "Blood pressure 90/60", label: "observed", at: r.mist.signs[0]!.at, event_ids: r.mist.signs[0]!.event_ids }))).not.toEqual([]);
  });

  it("is reachable by its secret token only", () => {
    const { h, incident } = scene();
    expect(h.net.reportByToken(incident.report_token)?.incident_id).toBe(incident.incident_id);
    expect(h.net.reportByToken("wrong-token-0000000")).toBeUndefined();
  });

  it("uses approved step labels when given", () => {
    const { h, incident } = scene();
    const r = h.net.report(incident.incident_id, { stepLabels: { apply_tourniquet: "Tourniquet tightened" } })!;
    expect(texts(r.timeline)).toContain("2:14 PM Guide advanced past: Tourniquet tightened");
  });
});

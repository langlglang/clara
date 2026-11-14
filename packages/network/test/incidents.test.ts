import { describe, expect, it } from "vitest";
import { comingLine, type BoxPush } from "@clara/contracts";
import { batch, boxEvents, harness, heartbeat, type Harness } from "./helpers.js";

/** Opens the lid and sends an SOS on box-clinic; returns the incident. */
function openSos(h: Harness, need: "bleeding" | "breathing" | "general" = "bleeding") {
  const ev = boxEvents("box-clinic");
  const r = h.net.ingest(
    batch(
      ev.make("box.opened", h.at(), {}),
      ev.make("sos.countdown", h.at(1000), { seconds: 5, source: "touch" }),
      ev.make("sos.opened", h.at(6000), { need, source: "system" }),
    ),
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.opened).toHaveLength(1);
  return { ev, incident: r.opened[0]!, result: r };
}

const pushesOf = (pushes: { box_id: string; push: BoxPush }[], type: BoxPush["type"]) => pushes.filter((p) => p.push.type === type);

describe("incidents", () => {
  it("opens one incident per box; a repeated SOS joins it", () => {
    const h = harness();
    const { ev, incident } = openSos(h);
    const again = h.net.ingest(batch(ev.make("sos.opened", h.at(9000), { need: "general", source: "voice" })));
    expect(again.ok && again.opened).toEqual([]);
    expect(h.net.incidents()).toHaveLength(1);
    expect(h.net.openIncidentForBox("box-clinic")?.incident.incident_id).toBe(incident.incident_id);
    expect(incident.need).toBe("bleeding");
    expect(incident.session_id).toBe(ev.session_id);
  });

  it("ingest is idempotent by event_id", () => {
    const h = harness();
    const ev = boxEvents("box-clinic");
    const b = batch(ev.make("box.opened", h.at(), {}), ev.make("sos.opened", h.at(1000), { need: "bleeding", source: "touch" }));
    const first = h.net.ingest(b);
    const second = h.net.ingest(b);
    expect(first.ok && first.accepted).toHaveLength(2);
    expect(second.ok && second.accepted).toHaveLength(0);
    expect(second.ok && second.duplicates).toHaveLength(2);
    expect(second.ok && second.pushes).toEqual([]);
    expect(h.net.incidents()).toHaveLength(1);
    expect(h.net.store.eventsForBox("box-clinic")).toHaveLength(2);
  });

  it("rejects malformed batches and events for unknown boxes", () => {
    const h = harness();
    expect(h.net.ingest({ schema_version: "nope", events: [] }).ok).toBe(false);
    const ev = boxEvents("box-unknown");
    const r = h.net.ingest(batch(ev.make("box.opened", h.at(), {})));
    expect(r.ok && r.unknown_box).toHaveLength(1);
    expect(h.net.store.eventsForBox("box-unknown")).toHaveLength(0);
  });

  it("alerts the top 3 matching volunteers, nearest ETA first", () => {
    const h = harness();
    const { incident, result } = openSos(h, "bleeding");
    // Yusuf 0.20 km and Amina 0.24 km walk 3 min; Tomas drives 1.4 km in 3 min. Lena (cpr only), Samir (driver
    // only) and Daniel (unavailable) never qualify for bleeding.
    expect(incident.alerts.map((a) => a.volunteer_id)).toEqual(["vol-yusuf", "vol-amina", "vol-tomas"]);
    expect(incident.alerts.every((a) => a.state === "sent" && a.eta_minutes === null)).toBe(true);
    expect(pushesOf(result.ok ? result.pushes : [], "alert.update").every((p) => p.box_id === "box-clinic")).toBe(true);
  });

  it("box says nothing about help until a volunteer's own coming; then the template line", () => {
    const h = harness();
    const { incident } = openSos(h);
    expect(h.net.comingLine("box-clinic")).toBeNull();
    // Shown is not coming.
    const amina = incident.alerts.find((a) => a.volunteer_id === "vol-amina")!;
    h.net.inbox("vol-amina");
    expect(h.net.incident(incident.incident_id)!.incident.alerts.find((a) => a.alert_id === amina.alert_id)!.state).toBe("shown");
    expect(h.net.comingLine("box-clinic")).toBeNull();
    // Another volunteer can't accept for Amina.
    expect(h.net.respond(amina.alert_id, "vol-yusuf", "coming").outcome).toBe("not_yours");
    expect(h.net.comingLine("box-clinic")).toBeNull();

    const r = h.net.respond(amina.alert_id, "vol-amina", "coming");
    expect(r.outcome).toBe("answered");
    if (r.outcome !== "answered") return;
    expect(r.alert.eta_minutes).toBe(3);
    expect(r.pushes).toEqual([{ box_id: "box-clinic", push: { type: "alert.update", incident_id: incident.incident_id, alert: r.alert } }]);
    expect(h.net.comingLine("box-clinic")).toBe("Amina is coming, about 3 minutes.");
    expect(h.net.comingLine("box-clinic")).toBe(comingLine(r.incident.alerts));
  });

  it("valid and invalid transitions; repeated taps are harmless", () => {
    const h = harness();
    const { incident } = openSos(h);
    const a = incident.alerts[0]!;
    const vid = a.volunteer_id;
    expect(h.net.respond(a.alert_id, vid, "shown").outcome).toBe("answered");
    expect(h.net.respond(a.alert_id, vid, "shown").outcome).toBe("unchanged");
    expect(h.net.respond(a.alert_id, vid, "coming").outcome).toBe("answered");
    const repeat = h.net.respond(a.alert_id, vid, "coming");
    expect(repeat.outcome).toBe("unchanged");
    expect(repeat.outcome === "unchanged" && repeat.pushes).toEqual([]);
    expect(h.net.respond(a.alert_id, vid, "shown").outcome).toBe("unchanged");
    expect(h.net.respond(a.alert_id, vid, "arrived").outcome).toBe("answered");
    expect(h.net.respond(a.alert_id, vid, "arrived").outcome).toBe("unchanged");
    expect(h.net.respond(a.alert_id, vid, "declined").outcome).toBe("invalid");
    expect(h.net.comingLine("box-clinic")).toBe("Yusuf is here.");
    expect(h.net.respond("alert_nope", vid, "coming").outcome).toBe("not_found");
    expect(() => h.net.respond(a.alert_id, vid, "teleported")).toThrow();
  });

  it("a decline after coming takes the name back off the box", () => {
    const h = harness();
    const { incident } = openSos(h);
    const a = incident.alerts[1]!;
    h.net.respond(a.alert_id, a.volunteer_id, "coming");
    expect(h.net.comingLine("box-clinic")).not.toBeNull();
    expect(h.net.respond(a.alert_id, a.volunteer_id, "declined").outcome).toBe("answered");
    expect(h.net.comingLine("box-clinic")).toBeNull();
  });

  it("escalates: next 3 at 60 s, everyone matching at 120 s, flagged for the dashboard", () => {
    const h = harness();
    for (const [i, km] of [0.3, 0.6, 0.9].entries()) {
      h.net.registerVolunteer({ volunteer_id: `vol-extra-${i}`, name: `Extra ${i}`, skills: ["first_aid"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.35 + km / 111, lng: -74.67 }, available: true, channel: "app" });
    }
    const { incident } = openSos(h, "bleeding");
    expect(incident.alerts).toHaveLength(3);
    const all = h.net.candidates(incident.incident_id).length + 3;
    expect(all).toBeGreaterThan(6);

    h.advance(59_000);
    expect(h.net.tick().pushes).toEqual([]);
    expect(h.net.incident(incident.incident_id)!.escalation).toEqual({ level: "first", flag: null });

    h.advance(1_000);
    const t60 = h.net.tick();
    expect(pushesOf(t60.pushes, "alert.update")).toHaveLength(3);
    expect(h.net.incident(incident.incident_id)!.incident.alerts).toHaveLength(6);
    expect(h.net.tick().pushes).toEqual([]); // ticking again sends nothing new

    h.advance(60_000);
    h.net.tick();
    const v = h.net.incident(incident.incident_id)!;
    expect(v.incident.alerts).toHaveLength(all);
    expect(new Set(v.incident.alerts.map((a) => a.volunteer_id)).size).toBe(all);
    expect(v.escalation).toEqual({ level: "all", flag: "no_reply" });
  });

  it("does not escalate while someone is coming", () => {
    const h = harness();
    const { incident } = openSos(h);
    h.net.respond(incident.alerts[0]!.alert_id, incident.alerts[0]!.volunteer_id, "coming");
    h.advance(130_000);
    expect(h.net.tick().pushes).toEqual([]);
    expect(h.net.incident(incident.incident_id)!.incident.alerts).toHaveLength(3);
    expect(h.net.incident(incident.incident_id)!.escalation.flag).toBeNull();
  });

  it("nearby boxes are told only after the person at the SOS box asks, and get nearby.clear on close", () => {
    const h = harness();
    const { ev, incident, result } = openSos(h);
    // The SOS alone alerts volunteers, never other boxes.
    expect(pushesOf(result.ok ? result.pushes : [], "nearby.emergency")).toEqual([]);
    // Another box (or the same box in another session) can't send for kits.
    const other = boxEvents("box-room-101");
    const stranger = h.net.ingest(batch(other.make("nearby.requested", h.at(7000), { source: "touch" })));
    expect(pushesOf(stranger.ok ? stranger.pushes : [], "nearby.emergency")).toEqual([]);
    const asked = h.net.ingest(batch(ev.make("nearby.requested", h.at(8000), { source: "voice" })));
    const nearby = pushesOf(asked.ok ? asked.pushes : [], "nearby.emergency");
    // Asking twice tells nobody twice.
    const again = h.net.ingest(batch(ev.make("nearby.requested", h.at(9000), { source: "touch" })));
    expect(pushesOf(again.ok ? again.pushes : [], "nearby.emergency")).toEqual([]);
    // Room 101 is 0.4 km away; Water point 3 is 1.6 km away.
    expect(nearby).toEqual([
      {
        box_id: "box-room-101",
        push: { type: "nearby.emergency", incident_id: incident.incident_id, from_box_id: "box-clinic", from_box_name: "Clinic tent", directions: expect.stringContaining("Clinic tent") },
      },
    ]);
    const a = incident.alerts[0]!;
    h.net.respond(a.alert_id, a.volunteer_id, "coming");
    h.net.respond(a.alert_id, a.volunteer_id, "arrived");
    const closed = h.net.ingest(batch(ev.make("box.closed", h.at(60_000), {})));
    if (!closed.ok) throw new Error(closed.error);
    expect(closed.closed[0]!.closed?.how).toBe("arrived");
    expect(pushesOf(closed.pushes, "nearby.clear")).toEqual([{ box_id: "box-room-101", push: { type: "nearby.clear", incident_id: incident.incident_id } }]);
    // Unanswered alerts end cancelled and the box hears about each.
    const after = h.net.incident(incident.incident_id)!.incident;
    expect(after.alerts.map((x) => x.state)).toEqual(["arrived", "cancelled", "cancelled"]);
    expect(pushesOf(closed.pushes, "alert.update")).toHaveLength(2);
  });

  it("late responses to a closed incident are rejected; the first close wins", () => {
    const h = harness();
    const { ev, incident } = openSos(h);
    h.net.ingest(batch(ev.make("box.closed", h.at(30_000), {})));
    const late = h.net.respond(incident.alerts[0]!.alert_id, incident.alerts[0]!.volunteer_id, "coming");
    expect(late.outcome).toBe("closed");
    expect(h.net.comingLine("box-clinic")).toBeNull();
    // A later expiry tick doesn't rewrite how it closed.
    h.advance(2 * 60 * 60_000);
    h.net.tick();
    expect(h.net.incident(incident.incident_id)!.incident.closed?.how).toBe("cancelled");
  });

  it("sos.cancelled after the SOS closes it; a countdown cancel before it doesn't open one", () => {
    const h = harness();
    const ev = boxEvents("box-clinic");
    const r = h.net.ingest(batch(ev.make("box.opened", h.at(), {}), ev.make("sos.countdown", h.at(1000), { seconds: 5, source: "touch" }), ev.make("sos.cancelled", h.at(2000), { source: "touch" })));
    expect(r.ok && r.opened).toEqual([]);
    h.net.ingest(batch(ev.make("sos.opened", h.at(10_000), { need: "general", source: "touch" })));
    const open = h.net.openIncidentForBox("box-clinic")!;
    const c = h.net.ingest(batch(ev.make("sos.cancelled", h.at(20_000), { source: "touch" })));
    expect(c.ok && c.closed.map((i) => i.closed?.how)).toEqual(["cancelled"]);
    expect(h.net.incident(open.incident.incident_id)!.incident.alerts.every((a) => a.state === "cancelled")).toBe(true);
  });

  it("expires an incident left open for an hour", () => {
    const h = harness();
    const { ev, incident } = openSos(h);
    h.net.ingest(batch(ev.make("nearby.requested", h.at(8000), { source: "touch" })));
    h.advance(60 * 60_000);
    const t = h.net.tick();
    expect(h.net.incident(incident.incident_id)!.incident.closed?.how).toBe("expired");
    expect(h.net.incident(incident.incident_id)!.incident.alerts.every((a) => a.state === "expired")).toBe(true);
    expect(pushesOf(t.pushes, "nearby.clear")).toHaveLength(1);
  });

  it("a volunteer coming to one incident isn't alerted for another", () => {
    const h = harness();
    const { incident } = openSos(h);
    const yusuf = incident.alerts.find((a) => a.volunteer_id === "vol-yusuf")!;
    h.net.respond(yusuf.alert_id, "vol-yusuf", "coming");
    const ev = boxEvents("box-room-101");
    const r = h.net.ingest(batch(ev.make("sos.opened", h.at(), { need: "bleeding", source: "touch" })));
    expect(r.ok && r.opened[0]!.alerts.map((a) => a.volunteer_id)).not.toContain("vol-yusuf");
  });

  it("subscribers get store changes and box pushes live", () => {
    const h = harness();
    heartbeat(h, "box-room-101");
    const seen: string[] = [];
    const off = h.net.subscribe((c) => seen.push(c.kind === "push" ? `push:${c.box_id}:${c.push.type}` : c.kind));
    const { ev } = openSos(h);
    h.net.ingest(batch(ev.make("nearby.requested", h.at(8000), { source: "touch" })));
    expect(seen).toContain("incident");
    expect(seen).toContain("event");
    expect(seen).toContain("push:box-clinic:alert.update");
    expect(seen).toContain("push:box-room-101:nearby.emergency");
    off();
    const n = seen.length;
    heartbeat(h, "box-clinic");
    expect(seen.length).toBe(n);
  });
});

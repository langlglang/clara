import { describe, expect, it } from "vitest";
import { batch, boxEvents, harness, type Harness } from "./helpers.js";

function openSos(h: Harness, box = "box-clinic") {
  const ev = boxEvents(box);
  const r = h.net.ingest(batch(ev.make("box.opened", h.at(), {}), ev.make("sos.opened", h.at(1000), { need: "bleeding", source: "touch" })));
  if (!r.ok) throw new Error(r.error);
  return r.opened[0]!;
}

describe("alertVolunteers", () => {
  it("alerts listed candidates and refuses everyone else with a reason", () => {
    const h = harness();
    const incident = openSos(h);
    const firstWave = incident.alerts.map((a) => a.volunteer_id);
    const next = h.net.candidates(incident.incident_id)[0]!.volunteer.volunteer_id;
    const pushes: string[] = [];
    h.net.subscribe((c) => {
      if (c.kind === "push" && c.push.type === "alert.update") pushes.push(c.push.alert.volunteer_id);
    });
    const r = h.net.alertVolunteers(incident.incident_id, [next, next, firstWave[0]!, "vol-daniel", "vol-nobody"], "test");
    expect(r.outcome).toBe("alerted");
    if (r.outcome !== "alerted") return;
    expect(r.alerted.map((a) => a.volunteer_id)).toEqual([next]);
    expect(r.alerted[0]!.state).toBe("sent");
    expect(r.refused).toEqual([
      { volunteer_id: next, why: "duplicate" },
      { volunteer_id: firstWave[0], why: "already_alerted" },
      { volunteer_id: "vol-daniel", why: "not_a_candidate" },
      { volunteer_id: "vol-nobody", why: "not_a_candidate" },
    ]);
    expect(pushes).toEqual([next]);
    expect(h.net.incident(incident.incident_id)!.incident.alerts).toHaveLength(firstWave.length + 1);
    expect(h.net.comingLine("box-clinic")).toBeNull();
  });

  it("refuses closed and unknown incidents", () => {
    const h = harness();
    expect(h.net.alertVolunteers("inc_nope", ["vol-grace"]).outcome).toBe("not_found");
    const incident = openSos(h);
    h.advance(61 * 60_000);
    h.net.tick();
    expect(h.net.alertVolunteers(incident.incident_id, ["vol-grace"]).outcome).toBe("closed");
  });

  it("leaves the automatic waves as they were when unused", () => {
    const h = harness();
    const incident = openSos(h);
    expect(incident.alerts).toHaveLength(3);
    h.advance(61_000);
    h.net.tick();
    expect(h.net.incident(incident.incident_id)!.incident.alerts.length).toBeGreaterThan(3);
  });
});

describe("requestKit", () => {
  it("pushes nearby.emergency to one box and clears it on close", () => {
    const h = harness();
    const incident = openSos(h);
    const seen: { box: string; type: string }[] = [];
    h.net.subscribe((c) => {
      if (c.kind === "push") seen.push({ box: c.box_id, type: c.push.type });
    });
    // Nobody may send for another kit until the person at the SOS box asks.
    expect(h.net.requestKit(incident.incident_id, "box-water-point").outcome).toBe("not_requested");
    expect(seen).toEqual([]);
    h.net.ingest(batch(boxEvents("box-clinic", incident.session_id).make("nearby.requested", h.at(2000), { source: "touch" })));
    seen.length = 0;
    const r = h.net.requestKit(incident.incident_id, "box-water-point");
    expect(r).toMatchObject({ outcome: "requested", already_told: false });
    expect(seen).toEqual([{ box: "box-water-point", type: "nearby.emergency" }]);
    expect(h.net.requestKit(incident.incident_id, "box-water-point")).toMatchObject({ outcome: "requested", already_told: true });
    expect(h.net.requestKit(incident.incident_id, "box-clinic").outcome).toBe("own_box");
    expect(h.net.requestKit(incident.incident_id, "box-nope").outcome).toBe("unknown_box");
    seen.length = 0;
    h.advance(61 * 60_000);
    h.net.tick();
    expect(seen).toContainEqual({ box: "box-water-point", type: "nearby.clear" });
  });
});

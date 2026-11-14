import { describe, expect, it } from "vitest";
import type { Volunteer } from "@clara/contracts";
import { MATCH_RADIUS_KM, radiusFor, rankVolunteers } from "../src/index.js";
import { batch, boxEvents, harness } from "./helpers.js";

const box = { lat: 40.35, lng: -74.66 };
/** About 3.3 km north of the box. */
const far = { lat: 40.38, lng: -74.66 };

const vol = (id: string, extra: Partial<Volunteer> = {}): Volunteer => ({
  volunteer_id: id,
  name: id,
  skills: ["first_aid"],
  languages: ["en"],
  vehicle_seats: 0,
  location: far,
  available: true,
  channel: "app",
  ...extra,
});

describe("alert radius", () => {
  it("keeps the network default when a volunteer has no radius of their own", () => {
    expect(radiusFor(vol("a"))).toBe(MATCH_RADIUS_KM);
    expect(rankVolunteers([vol("a")], box, "bleeding").map((c) => c.volunteer.volunteer_id)).toEqual(["a"]);
  });

  it("leaves out a volunteer whose own radius is smaller than their distance", () => {
    const ranked = rankVolunteers([vol("near-enough", { alert_radius_km: 5 }), vol("too-far", { alert_radius_km: 2 })], box, "bleeding");
    expect(ranked.map((c) => c.volunteer.volunteer_id)).toEqual(["near-enough"]);
  });

  it("never widens past the network's radius", () => {
    expect(radiusFor(vol("a", { alert_radius_km: 10 }), 3)).toBe(3);
    expect(rankVolunteers([vol("a", { alert_radius_km: 10 })], box, "bleeding", { radiusKm: 3 })).toHaveLength(0);
  });

  it("an incident alerts only volunteers inside their own radius", () => {
    const h = harness();
    // Yusuf (~0.2 km from the clinic box) keeps a 0.5 km radius and is alerted; Amina moves ~0.9 km away with a
    // 0.5 km radius and isn't, though she'd be in the first wave on the network default.
    h.net.updateVolunteer("vol-yusuf", { alert_radius_km: 0.5 });
    h.net.updateVolunteer("vol-amina", { location: { lat: 40.358, lng: -74.66 }, alert_radius_km: 0.5 });
    const ev = boxEvents("box-clinic");
    const r = h.net.ingest(batch(ev.make("box.opened", h.at(), {}), ev.make("sos.opened", h.at(1000), { need: "bleeding", source: "touch" })));
    if (!r.ok) throw new Error(r.error);
    const ids = r.opened[0]!.alerts.map((a) => a.volunteer_id);
    expect(ids).toContain("vol-yusuf");
    expect(ids).not.toContain("vol-amina");
    // Escalating to everyone still leaves her out.
    h.advance(121_000);
    h.net.tick();
    const all = h.net.incident(r.opened[0]!.incident_id)!.incident.alerts.map((a) => a.volunteer_id);
    expect(all).not.toContain("vol-amina");
  });

  it("updateVolunteer removes a field set to undefined and refuses a radius outside 0.5–10 km", () => {
    const h = harness();
    h.net.updateVolunteer("vol-yusuf", { alert_radius_km: 2 });
    expect(h.net.updateVolunteer("vol-yusuf", { alert_radius_km: undefined })?.alert_radius_km).toBeUndefined();
    expect(() => h.net.updateVolunteer("vol-yusuf", { alert_radius_km: 0.1 })).toThrow();
    expect(() => h.net.updateVolunteer("vol-yusuf", { alert_radius_km: 25 })).toThrow();
  });
});

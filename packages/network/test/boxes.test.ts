import { describe, expect, it } from "vitest";
import { estimateEta, haversineKm, rankVolunteers, DEMO_BOXES, DEMO_VOLUNTEERS } from "../src/index.js";
import { batch, boxEvents, harness, heartbeat } from "./helpers.js";

describe("box status", () => {
  it("is offline before any contact and after 90 s without one", () => {
    const h = harness();
    expect(h.net.kitMap().find((p) => p.box_id === "box-clinic")!.status).toBe("offline");
    heartbeat(h, "box-clinic");
    const pin = h.net.kitMap().find((p) => p.box_id === "box-clinic")!;
    expect(pin).toMatchObject({ status: "ready", last_updated_at: h.at(), last_updated_seconds_ago: 0, battery_pct: 80 });

    h.advance(90_000);
    expect(h.net.tick().maintainer).toEqual([]);
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("ready");
    h.advance(1_000);
    const t = h.net.tick();
    expect(t.maintainer).toEqual([expect.objectContaining({ kind: "offline", box_id: "box-clinic" })]);
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("offline");
    expect(h.net.tick().maintainer).toEqual([]); // once per outage
    heartbeat(h, "box-clinic");
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("ready");
  });

  it("is in_use while the lid is open, ready after it closes", () => {
    const h = harness();
    const ev = boxEvents("box-clinic");
    h.net.ingest(batch(ev.make("box.opened", h.at(), {})));
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("in_use");
    h.net.ingest(batch(ev.make("box.closed", h.at(5000), {})));
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("ready");
  });

  it("goes low_supplies from confirmed use only, alerts the maintainer once, and restock resets it", () => {
    const h = harness();
    const ev = boxEvents("box-clinic");
    // Proposed by the model, not confirmed: counts for nothing.
    h.net.ingest(batch(ev.make("supply.used", h.at(), { sku: "tourniquet", qty: 2, confirmed: false })));
    expect(h.net.supplies("box-clinic")!.low_skus).toEqual([]);

    const gauze = ev.make("supply.used", h.at(1000), { sku: "gauze", qty: 4, confirmed: true });
    h.net.ingest(batch(gauze));
    expect(h.net.supplies("box-clinic")!.items.find((i) => i.sku === "gauze")).toMatchObject({ stocked: 10, used: 4, remaining: 6, low: false });

    const tq = ev.make("supply.used", h.at(2000), { sku: "tourniquet", qty: 1, confirmed: true });
    const r = h.net.ingest(batch(tq, ev.make("box.closed", h.at(3000), {})));
    expect(r.ok && r.maintainer).toEqual([expect.objectContaining({ kind: "low_supplies", box_id: "box-clinic", skus: ["tourniquet"], event_ids: [tq.event_id] })]);
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("low_supplies");
    expect(h.net.kitMap().find((p) => p.box_id === "box-clinic")!.status).toBe("low_supplies");

    // More use doesn't repeat the alert.
    const again = h.net.ingest(batch(ev.make("supply.used", h.at(4000), { sku: "gauze", qty: 2, confirmed: true })));
    expect(again.ok && again.maintainer).toEqual([]);
    expect(h.net.supplies("box-clinic")!.low_skus).toEqual(["tourniquet", "gauze"]);

    const after = h.net.restock("box-clinic")!;
    expect(after.low_skus).toEqual([]);
    expect(after.items.every((i) => i.used === 0)).toBe(true);
    expect(h.net.store.getBox("box-clinic")!.box.status).toBe("ready");
  });

  it("lists unlisted skus without counting them toward low", () => {
    const h = harness();
    const ev = boxEvents("box-clinic");
    h.net.ingest(batch(ev.make("supply.used", h.at(), { sku: "splint", qty: 1, confirmed: true })));
    expect(h.net.supplies("box-clinic")!.unlisted).toMatchObject([{ sku: "splint", used: 1 }]);
    expect(h.net.supplies("box-clinic")!.low_skus).toEqual([]);
  });

  it("the maintainer view has every box with its counts", () => {
    const h = harness();
    heartbeat(h, "box-room-101");
    const rows = h.net.maintainer();
    expect(rows.map((r) => r.box.box_id)).toEqual(DEMO_BOXES.map((b) => b.box_id));
    expect(rows.find((r) => r.box.box_id === "box-room-101")).toMatchObject({ online: true, box: { status: "ready" } });
  });
});

describe("matching", () => {
  const clinic = DEMO_BOXES[0]!.location;

  it("haversine is about right", () => {
    expect(haversineKm({ lat: 40, lng: -74 }, { lat: 41, lng: -74 })).toBeCloseTo(111.2, 0);
    expect(haversineKm(clinic, clinic)).toBe(0);
  });

  it("walks at 5 km/h; drives at 30 km/h only with a vehicle beyond 1 km", () => {
    expect(estimateEta(0.5, 3)).toEqual({ mode: "walking", minutes: 6 });
    expect(estimateEta(2, 0)).toEqual({ mode: "walking", minutes: 24 });
    expect(estimateEta(2, 3)).toEqual({ mode: "driving", minutes: 4 });
  });

  it("matches skills to the need", () => {
    const ids = (need: "bleeding" | "breathing" | "general") => rankVolunteers(DEMO_VOLUNTEERS, clinic, need).map((c) => c.volunteer.volunteer_id);
    expect(ids("bleeding")).not.toContain("vol-lena"); // cpr only
    expect(ids("breathing")).toContain("vol-lena");
    expect(ids("breathing")).not.toContain("vol-yusuf"); // stop_the_bleed, first_aid
    expect(ids("general")).toContain("vol-mei"); // midwife
    for (const need of ["bleeding", "breathing", "general"] as const) {
      expect(ids(need)).not.toContain("vol-samir"); // driver only
      expect(ids(need)).not.toContain("vol-daniel"); // unavailable
    }
    const ranked = rankVolunteers(DEMO_VOLUNTEERS, clinic, "general");
    expect(ranked.map((c) => c.eta.minutes)).toEqual([...ranked.map((c) => c.eta.minutes)].sort((a, b) => a - b));
  });

  it("leaves out volunteers beyond the radius", () => {
    const far = { ...DEMO_VOLUNTEERS[0]!, volunteer_id: "vol-far", location: { lat: 41, lng: -74.66 } };
    expect(rankVolunteers([far], clinic, "bleeding")).toEqual([]);
  });
});

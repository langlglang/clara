import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_VERSION, type BoxEvent } from "@clara/contracts";
import { randomUUID } from "node:crypto";
import { createCoordinator } from "../src/coordinator.js";
import { createToolLayer } from "../src/tools.js";
import type { RideSummary, RidesAdapter } from "../src/types.js";
import type { RunInput } from "../src/runner.js";
import { emptyState, harness, openSos, type Harness } from "./helpers.js";

/** A fake ride book with preview and requestNow: Samir 5 min pickup, 13 min to the fictional hospital. */
function careRides(opts: { pickup?: number } = {}) {
  const rides = new Map<string, RideSummary>();
  const calls: string[] = [];
  const samir = { driver_id: "vol-samir", name: "Samir", vehicle: "car", seats: 4, distance_km: 0.4, pickup_minutes: opts.pickup ?? 5, suitable: true, reasons: [], hospital_minutes: 13 };
  const adapter: RidesAdapter & { calls: string[]; rides: Map<string, RideSummary> } = {
    calls,
    rides,
    forIncident: (id) => rides.get(id),
    request(id, note) {
      calls.push(`request:${id}`);
      const r: RideSummary = rides.get(id) ?? { ride_id: `ride-${id}`, incident_id: id, state: "planning", note, offers: [], winner: null, suggested: samir, backups: [], hospital_minutes: 13 };
      rides.set(id, r);
      return r;
    },
    preview: () => ({ hospital: { name: "District Hospital (fictional)", drive_minutes: 13 }, seats_needed: 1, drivers: [samir] }),
    requestNow(id) {
      calls.push(`requestNow:${id}`);
      const r: RideSummary = { ride_id: `ride-${id}`, incident_id: id, state: "offered", note: null, offers: [{ driver_id: "vol-samir", driver_name: "Samir", state: "offered" }], winner: null, suggested: null, backups: [], hospital_minutes: 13 };
      rides.set(id, r);
      return { ok: true, ride: r, offered_to: ["Samir"] };
    },
  };
  return adapter;
}

function layer(h: Harness, id: string, rides: RidesAdapter, ambulanceEtaMin: number | null = 35, run = 1, state = emptyState(id)) {
  const tools = createToolLayer({ network: h.net, rides, ambulanceEtaMin, incidentId: id, state, run, clock: () => new Date(h.now.ms), changed: () => undefined });
  return { tools, state };
}

describe("estimate_time_to_care and request_ride", () => {
  it("estimates from the incident (SOS, tourniquet) and the demo ambulance setting, and logs it", () => {
    const h = harness();
    const id = openSos(h, "box-clinic", { tourniquet: true });
    h.advance(2 * 60_000);
    const { tools, state } = layer(h, id, careRides());
    const r = tools.estimate_time_to_care();
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ verdict: "ambulance_late_driver_faster", qualifies_for_request: true, ride_active: false, deadline: { reach_hospital_within_min: 60, demo_value: true } });
    expect((r as unknown as { minutes_since_tourniquet: number }).minutes_since_tourniquet).toBeGreaterThan(1.9);
    expect(state.log.time_to_care?.verdict).toBe("ambulance_late_driver_faster");
    expect(state.log.actions.at(-1)).toMatchObject({ tool: "estimate_time_to_care", kind: "read" });
  });

  it("request_ride needs a fresh qualifying estimate, then sends offers once", () => {
    const h = harness();
    const id = openSos(h);
    const rides = careRides();
    const { tools, state } = layer(h, id, rides);
    const early = tools.request_ride({ reason: "ambulance late" });
    expect(!early.ok && early.error).toMatch(/estimate_time_to_care first/);
    tools.estimate_time_to_care();
    expect(tools.request_ride({ reason: "" }).ok).toBe(false);
    const r = tools.request_ride({ reason: "Ambulance (simulated) ~63 min vs Samir ~23 min, deadline 60 (demo)" });
    expect(r).toMatchObject({ ok: true, offered_to: ["Samir"], status: "offered_to_drivers" });
    expect(rides.calls).toEqual(["requestNow:" + id]);
    expect(state.log.ride_request).toMatchObject({ offered_to: ["Samir"], verdict: "ambulance_late_driver_faster" });
    tools.estimate_time_to_care();
    const again = tools.request_ride({ reason: "again" });
    expect(!again.ok && again.error).toMatch(/already requested/);
    expect(rides.calls).toHaveLength(1);
  });

  it("refuses when the ambulance is in time, the driver isn't 10 min faster, a ride is active, or the incident is closed", () => {
    const h = harness();
    const id = openSos(h);
    const inTime = layer(h, id, careRides(), 5);
    inTime.tools.estimate_time_to_care();
    expect(inTime.tools.request_ride({ reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/ambulance_in_time.*propose_ride/) });

    // Ambulance 35 + 15 + 13 = 63 vs a driver 40 + 5 + 13 = 58: late, but only 5 min faster.
    const slow = layer(h, id, careRides({ pickup: 40 }));
    slow.tools.estimate_time_to_care();
    expect(slow.tools.request_ride({ reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/only 5 min faster/) });

    const unknown = layer(h, id, careRides(), null);
    unknown.tools.estimate_time_to_care();
    expect(unknown.tools.request_ride({ reason: "r" }).ok).toBe(false);

    const busy = careRides();
    busy.rides.set(id, { ride_id: "r1", incident_id: id, state: "offered", note: null, offers: [], winner: null, suggested: null, backups: [], hospital_minutes: 13 });
    const active = layer(h, id, busy);
    active.tools.estimate_time_to_care();
    expect(active.tools.request_ride({ reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/already active/) });
    expect(busy.calls).toHaveLength(0);

    const stale = layer(h, id, careRides());
    stale.tools.estimate_time_to_care();
    const nextRun = layer(h, id, careRides(), 35, 2, stale.state);
    expect(nextRun.tools.request_ride({ reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/first in this run/) });

  });

  it("refuses on a closed incident", () => {
    const h = harness();
    const id = openSos(h);
    const rides = careRides();
    const { tools } = layer(h, id, rides);
    tools.estimate_time_to_care();
    const session = h.net.incident(id)!.incident.session_id;
    h.net.ingest({ schema_version: EVENTS_VERSION, events: [{ event_id: randomUUID(), box_id: "box-clinic", session_id: session, occurred_at: new Date(h.now.ms).toISOString(), type: "box.closed" } as BoxEvent] });
    expect(h.net.incident(id)!.incident.closed).not.toBeNull();
    expect(tools.request_ride({ reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
    expect(rides.calls).toHaveLength(0);
  });
});

describe("rules planner and triggers", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("rules: requests the ride when the verdict qualifies, without using the guidance timer as treatment proof", async () => {
    const h = harness();
    const rides = careRides();
    const c = createCoordinator({ network: h.net, rides, ambulanceEtaMin: 35, env: { CLARA_COORDINATOR: "rules" }, timers: false, debounceMs: 0, log: () => undefined });
    const id = openSos(h, "box-clinic", { tourniquet: true });
    await vi.advanceTimersByTimeAsync(10);
    await c.idle();
    const log = c.getLog(id)!;
    expect(log.actions.filter((a) => a.tool === "request_ride" && a.ok)).toHaveLength(1);
    expect(log.actions.filter((a) => a.tool === "propose_ride")).toHaveLength(0);
    expect(log.ride_request?.reason).toMatch(/Time to care: ambulance late, driver faster/);
    expect(log.notes.at(-1)?.text).toMatch(/requested a ride \(offered to Samir\)/);
    c.stop();
  });

  it("rules: without the ambulance setting a guidance timer alone does not prompt a ride", async () => {
    const h = harness();
    const rides = careRides();
    const c = createCoordinator({ network: h.net, rides, ambulanceEtaMin: null, env: { CLARA_COORDINATOR: "rules" }, timers: false, debounceMs: 0, log: () => undefined });
    const id = openSos(h, "box-clinic", { tourniquet: true });
    await vi.advanceTimersByTimeAsync(10);
    await c.idle();
    const log = c.getLog(id)!;
    expect(log.time_to_care?.verdict).toBe("unknown");
    expect(rides.calls.filter((x) => x.startsWith("requestNow"))).toHaveLength(0);
    expect(log.actions.filter((a) => a.tool === "propose_ride" && a.ok)).toHaveLength(0);
    c.stop();
  });

  it("re-runs when a tourniquet guidance timer starts or the SOS is opened again", async () => {
    const h = harness();
    const runs: RunInput[] = [];
    const c = createCoordinator({ network: h.net, runner: async (i) => void runs.push(i), timers: false, debounceMs: 100 });
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toHaveLength(1);
    const session = h.net.incident(id)!.incident.session_id;
    const mk = (type: string, body: Record<string, unknown>) => ({ event_id: randomUUID(), box_id: "box-clinic", session_id: session, occurred_at: new Date(h.now.ms).toISOString(), type, ...body }) as BoxEvent;
    h.net.ingest({ schema_version: EVENTS_VERSION, events: [mk("timer.started", { timer: "tourniquet", step_id: "tighten" })] });
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.trigger).toEqual(["tourniquet timer started"]);
    h.net.ingest({ schema_version: EVENTS_VERSION, events: [mk("sos.opened", { need: "bleeding", source: "touch" })] });
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toHaveLength(3);
    expect(runs[2]!.trigger).toEqual(["SOS opened"]);
    // A pressure timer doesn't count.
    h.net.ingest({ schema_version: EVENTS_VERSION, events: [mk("timer.started", { timer: "pressure", step_id: "direct_pressure" })] });
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toHaveLength(3);
    c.stop();
  });
});


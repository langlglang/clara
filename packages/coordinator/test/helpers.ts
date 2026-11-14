import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, type BoxEvent } from "@clara/contracts";
import { createNetwork, sequentialIds, type Network } from "@clara/network";
import { createToolLayer, type IncidentState } from "../src/tools.js";
import type { CoordinatorLog, RideSummary, RidesAdapter } from "../src/types.js";

export const T0 = Date.parse("2026-11-13T19:00:00.000Z");

export interface Harness {
  net: Network;
  now: { ms: number };
  advance(ms: number): void;
}

export function harness(): Harness {
  const now = { ms: T0 };
  const net = createNetwork({ clock: () => new Date(now.ms), ids: sequentialIds() });
  net.seedDemo();
  return { net, now, advance: (ms) => void (now.ms += ms) };
}

export function heartbeat(h: Harness, ...boxIds: string[]) {
  const at = new Date(h.now.ms).toISOString();
  const events: BoxEvent[] = boxIds.map((box_id) => ({ event_id: randomUUID(), box_id, session_id: null, occurred_at: at, type: "box.heartbeat", battery_pct: 80, online_parts: ["sim"] }));
  h.net.ingest({ schema_version: EVENTS_VERSION, events });
}

/** box.opened + sos.opened (+ optional tourniquet timer) on a box; returns the incident id. */
export function openSos(h: Harness, box = "box-clinic", opts: { tourniquet?: boolean; askNearby?: boolean } = {}): string {
  const session = randomUUID();
  const at = (ms: number) => new Date(h.now.ms + ms).toISOString();
  const mk = (type: string, ms: number, body: Record<string, unknown>) => ({ event_id: randomUUID(), box_id: box, session_id: session, occurred_at: at(ms), type, ...body }) as BoxEvent;
  const events: BoxEvent[] = [mk("box.opened", 0, {}), mk("sos.opened", 500, { need: "bleeding", source: "touch" })];
  if (opts.tourniquet) events.push(mk("timer.started", 800, { timer: "tourniquet", step_id: "apply-tourniquet" }));
  if (opts.askNearby) events.push(mk("nearby.requested", 900, { source: "touch" }));
  const r = h.net.ingest({ schema_version: EVENTS_VERSION, events });
  if (!r.ok) throw new Error(r.error);
  return r.opened[0]!.incident_id;
}

export function emptyState(incidentId: string): IncidentState {
  const log: CoordinatorLog = { incident_id: incidentId, mode: "rules", label: "rules", model: null, status: "idle", stopped_reason: null, plan: [], actions: [], notes: [], flags: [], subagents: [], memory: [], runs: [], extra_alerts: 0, updated_at: "" };
  return { log, kitRequests: new Set(), rideProposals: [] };
}

export function layerFor(h: Harness, incidentId: string, extra: { rides?: RidesAdapter; signal?: AbortSignal; state?: IncidentState } = {}) {
  const state = extra.state ?? emptyState(incidentId);
  const tools = createToolLayer({ network: h.net, rides: extra.rides, incidentId, state, run: 1, signal: extra.signal, clock: () => new Date(h.now.ms), changed: () => undefined });
  return { tools, state };
}

/** A fake ride book: one plan per incident with fixed driver options. Records approvals (there must be none). */
export function fakeRides() {
  const rides = new Map<string, RideSummary>();
  const calls: string[] = [];
  const adapter: RidesAdapter & { calls: string[]; approve?: never } = {
    calls,
    forIncident: (id) => rides.get(id),
    request(id, note) {
      calls.push(`request:${id}`);
      let r = rides.get(id);
      if (!r) {
        r = {
          ride_id: `ride-${id}`,
          incident_id: id,
          state: "planning",
          note,
          offers: [],
          winner: null,
          suggested: { driver_id: "vol-samir", name: "Samir", vehicle: "car", seats: 4, distance_km: 0.4, pickup_minutes: 5, suitable: true, reasons: ["closest free driver"] },
          backups: [{ driver_id: "vol-moto", name: "Moto", vehicle: "motorbike", seats: 1, distance_km: 0.2, pickup_minutes: 3, suitable: false, reasons: ["motorbike: not suitable for a patient"] }],
          hospital_minutes: 12,
        };
        rides.set(id, r);
      }
      return r;
    },
  };
  return adapter;
}

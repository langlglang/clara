import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, type BoxEvent, type LatLng } from "@clara/contracts";
import { DEMO_MANIFEST, DEMO_SITE } from "@clara/network";
import { createPlacement, graphView, type FloorGraph, type Placement, type PlanInput, type Plan, type ScanInfo, type ToolLogEntry } from "@clara/placement";
import type { Runtime } from "./server";

/**
 * Server side of the Admin app (/admin): areas and box health, and the kit placement planner (packages/placement)
 * with its run log, kept on globalThis like the runtime so `next dev` reloads share it.
 */

export interface Area {
  id: string;
  name: string;
  center: LatLng;
  radiusKm: number;
  zoom: number;
}

export const AREAS: Area[] = [
  { id: "houston", name: "Houston · Downtown", center: { lat: 29.7584604, lng: -95.3682126 }, radiusKm: 15, zoom: 17 },
  { id: "la", name: "Los Angeles · Downtown", center: { lat: 34.0522, lng: -118.2437 }, radiusKm: 25, zoom: 14 },
  { id: "camp", name: DEMO_SITE.name, center: DEMO_SITE.center, radiusKm: 10, zoom: 15 },
];

const km = (a: LatLng, b: LatLng) => {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

export interface AdminBox {
  box_id: string;
  name: string;
  at: LatLng;
  directions: string;
  status: string;
  online: boolean;
  battery_pct: number | null;
  last_seen_at: string | null;
  supplies: { sku: string; remaining: number; stocked: number; low: boolean }[];
  low_skus: string[];
  open_incident_id: string | null;
  planned: boolean;
}

export interface AdminBoxesResponse {
  area: Area;
  areas: Area[];
  boxes: AdminBox[];
  summary: { total: number; ready: number; low_supplies: number; in_use: number; offline: number; open_incidents: number; low_battery: number; avg_battery: number | null };
  server_time: string;
}

export function adminBoxes(rt: Runtime, areaId: string): AdminBoxesResponse {
  const area = AREAS.find((a) => a.id === areaId) ?? AREAS[0];
  const pins = new Map(rt.network.kitMap().map((p) => [p.box_id, p]));
  const boxes: AdminBox[] = rt.network
    .maintainer()
    .filter((r) => km(area.center, r.box.location) <= area.radiusKm)
    .map((r) => ({
      box_id: r.box.box_id,
      name: r.box.name,
      at: r.box.location,
      directions: r.box.directions,
      status: r.box.status,
      online: r.online,
      battery_pct: r.box.battery_pct,
      last_seen_at: r.box.last_seen_at,
      supplies: r.supplies.items.map((i) => ({ sku: i.sku, remaining: i.remaining, stocked: i.stocked, low: i.low })),
      low_skus: r.supplies.low_skus,
      open_incident_id: pins.get(r.box.box_id)?.open_incident_id ?? null,
      planned: r.box.box_id.startsWith("kit-"),
    }));
  const count = (s: string) => boxes.filter((b) => b.status === s).length;
  const batteries = boxes.map((b) => b.battery_pct).filter((x): x is number => x != null);
  return {
    area,
    areas: AREAS,
    boxes,
    summary: {
      total: boxes.length,
      ready: count("ready"),
      low_supplies: count("low_supplies"),
      in_use: count("in_use"),
      offline: count("offline"),
      open_incidents: boxes.filter((b) => b.open_incident_id).length,
      low_battery: batteries.filter((b) => b < 30).length,
      avg_battery: batteries.length ? Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length) : null,
    },
    server_time: rt.network.clock().toISOString(),
  };
}

/* ---------- planner ---------- */

export interface PlanJob {
  id: string;
  propertyId: number;
  status: "loading" | "planning" | "done" | "failed";
  mode: "agent" | "fallback" | null;
  started_at: string;
  log: ToolLogEntry[];
  thoughts: { at: string; text: string }[];
  plan: Plan | null;
  error: string | null;
  deployed: { at: string; box_ids: string[] } | null;
}

interface AdminState {
  placement: Placement;
  jobs: Map<string, PlanJob>;
  inputs: Map<number, Promise<{ input: PlanInput; scans: ScanInfo[]; warnings: string[] } | null>>;
}

const g = globalThis as unknown as { __claraAdmin?: AdminState };

export function admin(): AdminState {
  g.__claraAdmin ??= { placement: createPlacement(process.env as Record<string, string | undefined>), jobs: new Map(), inputs: new Map() };
  return g.__claraAdmin;
}

/** Building data (CoStar + Matterport + Vexcel), loaded once per building per process (each source caches on disk). */
export function loadBuilding(propertyId: number) {
  const s = admin();
  if (!s.inputs.has(propertyId)) {
    const p = s.placement.loadInput(propertyId).catch((e: Error) => {
      s.inputs.delete(propertyId);
      throw e;
    });
    s.inputs.set(propertyId, p);
  }
  return s.inputs.get(propertyId)!;
}

export function floorGraphs(graphs: FloorGraph[]) {
  return graphs.map(graphView);
}

export function startPlan(propertyId: number): PlanJob {
  const s = admin();
  const job: PlanJob = { id: randomUUID(), propertyId, status: "loading", mode: null, started_at: new Date().toISOString(), log: [], thoughts: [], plan: null, error: null, deployed: null };
  s.jobs.set(job.id, job);
  // Keep the last 20 jobs.
  for (const id of [...s.jobs.keys()].slice(0, Math.max(0, s.jobs.size - 20))) s.jobs.delete(id);
  const think = (text: string) => job.thoughts.push({ at: new Date().toISOString(), text });
  void (async () => {
    try {
      const loaded = await loadBuilding(propertyId);
      if (!loaded) throw new Error("Building not found.");
      for (const w of loaded.warnings) think(w);
      job.status = "planning";
      const r = await s.placement.plan(loaded.input, { onLog: (e) => job.log.push(e), onThought: think, signal: AbortSignal.timeout(180_000) });
      job.mode = r.mode;
      job.plan = r.plan;
      job.status = "done";
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message.slice(0, 300);
    }
  })();
  return job;
}

/**
 * Deploy a committed plan: each kit becomes a Clara box (network registerBox) with its written directions, gets a
 * simulated heartbeat (no hardware yet; plainly a demo), and shows on the kit map, the consoles and the admin map.
 */
export function deployPlan(rt: Runtime, job: PlanJob): string[] {
  if (!job.plan) throw new Error("No plan to deploy.");
  const ids: string[] = [];
  const short = job.plan.building.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 4) || "BLDG";
  for (const k of job.plan.kits) {
    const box_id = `kit-${job.plan.propertyId}-${k.level ?? "x"}-${k.panoId ? k.panoId.slice(0, 5) : "core"}`.toLowerCase();
    rt.network.registerBox({
      box_id,
      name: `${short} ${k.level == null ? "" : k.level < 0 ? `B${-k.level}` : `L${k.level}`} ${k.source === "scan" ? "floor kit" : "core kit"}`.replace(/\s+/g, " "),
      location: k.at,
      directions: `${job.plan.building}: ${k.directions}`,
      manifest: { ...DEMO_MANIFEST },
    });
    if (!rt.simulatedBoxes.includes(box_id)) rt.simulatedBoxes.push(box_id);
    ids.push(box_id);
  }
  const at = rt.network.clock().toISOString();
  const events: BoxEvent[] = ids.map((box_id) => ({ event_id: randomUUID(), box_id, session_id: null, occurred_at: at, type: "box.heartbeat", battery_pct: 100, online_parts: ["simulated"] }));
  rt.network.ingest({ schema_version: EVENTS_VERSION, events });
  job.deployed = { at, box_ids: ids };
  return ids;
}

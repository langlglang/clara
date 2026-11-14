import { coverage, greedyKits, TARGET_S, WALK_MPS, type FloorGraph } from "./graph.js";
import { pointSegmentM, projector, ringStats } from "./geo.js";
import type { Aerial, BuildingSummary, FloorCoverage, KitPlacement, LatLng, PickupPoint, Plan, PlanStats } from "./types.js";

/** Rules for floors without a scan (stated as assumptions on every plan). */
export interface RuleOptions {
  /** A floor with at least this many people gets its own kit by the elevator core. */
  denseThreshold: number;
  /** Other floors share one kit per this many consecutive floors (kit on the middle floor). */
  groupSize: number;
  /** Seconds to go one floor by the stairs, door to door. */
  stairSecondsPerFloor: number;
}
export const DEFAULT_RULES: RuleOptions = { denseThreshold: 150, groupSize: 3, stairSecondsPerFloor: 20 };

export interface PlanInput {
  building: BuildingSummary;
  graphs: FloorGraph[];
  aerial: Aerial | null;
}

const center = (input: PlanInput): LatLng => (input.aerial ? ringStats(input.aerial.footprint).centroid : input.building.location);

/** Map position: kits fan out on a small circle inside the footprint so each pin can be clicked (the floor is in the directions). */
function kitLatLng(input: PlanInput, i: number, total: number): LatLng {
  const c = center(input);
  const r = input.aerial ? Math.min(18, Math.sqrt(input.aerial.footprintAreaM2) / 4) : 12;
  const a = (2 * Math.PI * i) / Math.max(1, total);
  return projector(c).toLatLng(Math.cos(a) * r * (0.5 + 0.5 * ((i % 3) / 2)), Math.sin(a) * r * (0.5 + 0.5 * ((i % 3) / 2)));
}

const peopleOn = (b: BuildingSummary, level: number | null) => (level == null ? 0 : b.floors.filter((f) => f.level === level).reduce((s, f) => s + f.people, 0));
const levelName = (level: number | null) => (level == null ? "Unknown level" : level < 0 ? `Basement ${-level}` : `Level ${level}`);

/** Where on the floor, in words: relative to the scan's centre (scan axes taken as north-up: an assumption). */
export function sideWords(g: FloorGraph, idx: number): string {
  const p = g.nodes[idx];
  const cx = (g.extent.minX + g.extent.maxX) / 2, cy = (g.extent.minY + g.extent.maxY) / 2;
  const hx = Math.max(1, (g.extent.maxX - g.extent.minX) / 2), hy = Math.max(1, (g.extent.maxY - g.extent.minY) / 2);
  const nx = (p.x - cx) / hx, ny = (p.y - cy) / hy;
  if (Math.abs(nx) < 0.3 && Math.abs(ny) < 0.3) return "middle of the floor, near the elevator core";
  const ns = ny > 0.3 ? "north" : ny < -0.3 ? "south" : "";
  const ew = nx > 0.3 ? "east" : nx < -0.3 ? "west" : "";
  return `${ns}${ns && ew ? "-" : ""}${ew} side of the floor`;
}

export function scanKit(input: PlanInput, g: FloorGraph, idx: number, n: number, reason: string): KitPlacement {
  const p = g.nodes[idx];
  return {
    id: `scan-${g.modelId}-${p.id.slice(0, 6)}`,
    level: g.level,
    floorLabel: `${levelName(g.level)} · ${g.modelName}`,
    source: "scan",
    modelId: g.modelId,
    panoId: p.id,
    position: { x: p.x, y: p.y, z: p.z },
    at: kitLatLng(input, 0, 1),
    directions: `${levelName(g.level)}, ${sideWords(g, idx)} (scan ${g.modelName}, by scan point ${p.label || p.id.slice(0, 6)}). Wall-mounted at shoulder height.`,
    servesLevels: g.level == null ? [] : [g.level],
    people: Math.round(peopleOn(input.building, g.level) / Math.max(1, n)),
    reason,
  };
}

/** Kits for scanned floors: greedy over the walking graph, weighted equally per pano (people per floor are per floor, not per desk). */
export function planScanned(input: PlanInput, targetS = TARGET_S): KitPlacement[] {
  const kits: KitPlacement[] = [];
  for (const g of input.graphs) {
    const idx = greedyKits(g, { targetS });
    const cov = coverage(g, idx, targetS);
    idx.forEach((i, k) =>
      kits.push(scanKit(input, g, i, idx.length, `Greedy pick ${k + 1}/${idx.length} on the ${g.nodes.length}-point walking graph: every scanned point within ${targetS} s at ${WALK_MPS} m/s (worst ${cov.maxS ?? "?"} s).`)),
    );
  }
  return kits;
}

/** Estimated worst walk from the core to the far corner of a floor (seconds). */
export function coreReachS(b: BuildingSummary): number {
  const sqft = b.typicalFloorSqft ?? 25_000;
  const side = Math.sqrt(sqft * 0.0929);
  return Math.round((side * 0.75) / WALK_MPS);
}

/** Kits for floors without a scan: one per dense floor, else one per `groupSize` floors on the middle one, by the core. */
export function planCore(input: PlanInput, scannedLevels: number[], rules: RuleOptions = DEFAULT_RULES): KitPlacement[] {
  const b = input.building;
  const levels = [...new Set(b.floors.map((f) => f.level).filter((l): l is number => l != null))].sort((a, z) => a - z);
  const out: KitPlacement[] = [];
  const reach = coreReachS(b);
  let run: number[] = [];
  const flush = () => {
    while (run.length) {
      const group = run.splice(0, Math.max(1, rules.groupSize));
      const mid = group[Math.floor((group.length - 1) / 2)];
      const people = group.reduce((s, l) => s + peopleOn(b, l), 0);
      const worst = reach + rules.stairSecondsPerFloor * Math.max(mid - group[0], group[group.length - 1] - mid);
      const serves = group.length > 1 ? `; serves ${levelName(group[0])}–${group[group.length - 1]} by the stairs` : "";
      out.push({
        id: `core-L${mid}`,
        level: mid,
        floorLabel: levelName(mid),
        source: "core-rule",
        modelId: null,
        panoId: null,
        position: null,
        at: { lat: 0, lng: 0 },
        directions: `${levelName(mid)}, elevator lobby by the core, beside the stair door${serves}.`,
        servesLevels: group,
        people,
        reason: group.length === 1 ? `${people} people on this floor (≥ ${rules.denseThreshold}): own kit; est. worst walk ${worst} s.` : `${people} people across ${group.length} floors (each < ${rules.denseThreshold}): shared kit on the middle floor; est. worst walk ${worst} s (${reach} s across the floor + ${rules.stairSecondsPerFloor} s/floor by stairs).`,
      });
    }
  };
  for (const l of levels) {
    if (scannedLevels.includes(l)) {
      flush();
      continue;
    }
    if (peopleOn(b, l) >= rules.denseThreshold) {
      flush();
      run = [l];
      flush();
      continue;
    }
    run.push(l);
    if (run.length >= rules.groupSize) flush();
  }
  flush();
  return out;
}

/**
 * Pickup points for volunteer drivers: footprint edges whose midpoint is within 15 m of the parcel line face a
 * street (downtown parcels are whole blocks). One point per facing, at the longest such edge, 8 m out from the wall.
 */
export function pickupCandidates(aerial: Aerial | null): PickupPoint[] {
  if (!aerial || aerial.footprint.length < 3) return [];
  const origin = ringStats(aerial.footprint).centroid;
  const p = projector(origin);
  const fp = aerial.footprint.map((r) => p.toXY(r));
  const parcel = aerial.parcel.map((r) => p.toXY(r));
  const ccw = ringStats(aerial.footprint).signedArea > 0;
  const best = new Map<PickupPoint["facing"], { len: number; total: number; mx: number; my: number; nx: number; ny: number; gap: number }>();
  for (let i = 0; i < fp.length - 1; i++) {
    const [ax, ay] = fp[i], [bx, by] = fp[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 4) continue;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = (by - ay) / len, ny = -(bx - ax) / len;
    if (!ccw) (nx = -nx), (ny = -ny);
    let gap = Infinity;
    for (let j = 0; j < parcel.length - 1; j++) gap = Math.min(gap, pointSegmentM(mx, my, ...parcel[j], ...parcel[j + 1]));
    if (gap > 15) continue;
    const facing: PickupPoint["facing"] = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? "east" : "west") : ny > 0 ? "north" : "south";
    const cur = best.get(facing);
    const total = (cur?.total ?? 0) + len;
    if (!cur || len > cur.len) best.set(facing, { len, total, mx, my, nx, ny, gap });
    else cur.total = total;
  }
  return [...best.entries()].map(([facing, e]) => ({
    id: `pickup-${facing}`,
    facing,
    at: p.toLatLng(e.mx + e.nx * 8, e.my + e.ny * 8),
    edgeLengthM: Math.round(e.total),
    note: `${facing[0].toUpperCase()}${facing.slice(1)} curb (${Math.round(e.total)} m of street-facing wall on this side), 8 m out from its longest straight run; the wall is ${Math.round(e.gap)} m from the parcel line.`,
  }));
}

/** Coverage per scanned floor for a set of kits, and the whole-building stats. */
export function evaluate(input: PlanInput, kits: KitPlacement[], rules: RuleOptions = DEFAULT_RULES, targetS = TARGET_S): { coverage: FloorCoverage[]; stats: PlanStats } {
  const b = input.building;
  const cov: FloorCoverage[] = input.graphs.map((g) => {
    const idx = kits.filter((k) => k.modelId === g.modelId && k.panoId).map((k) => g.nodes.findIndex((n) => n.id === k.panoId)).filter((i) => i >= 0);
    const c = coverage(g, idx, targetS);
    return { level: g.level, label: g.label, modelId: g.modelId, panos: g.nodes.length, kits: idx.length, coveredPct: c.coveredPct, meanS: c.meanS, maxS: c.maxS, times: c.times };
  });
  const reach = coreReachS(b);
  const levelCovered = new Map<number, number>(); // level → covered fraction
  for (const c of cov) if (c.level != null) levelCovered.set(c.level, Math.max(levelCovered.get(c.level) ?? 0, c.coveredPct / 100));
  for (const k of kits)
    if (k.source === "core-rule" && k.level != null)
      for (const l of k.servesLevels) if (reach + rules.stairSecondsPerFloor * Math.abs(l - k.level) <= targetS) levelCovered.set(l, Math.max(levelCovered.get(l) ?? 0, 1));
  const levels = [...new Set(b.floors.map((f) => f.level).filter((l): l is number => l != null))];
  const peopleCovered = Math.round(levels.reduce((s, l) => s + peopleOn(b, l) * (levelCovered.get(l) ?? 0), 0));
  const totalPanos = cov.reduce((s, c) => s + c.panos, 0) || 1;
  const after = cov.reduce((s, c) => s + (c.coveredPct * c.panos) / totalPanos, 0);
  const maxes = cov.map((c) => c.maxS).filter((x): x is number => x != null);
  return {
    coverage: cov,
    stats: {
      totalPeople: b.totalPeople,
      peopleCovered,
      floorsTotal: levels.length,
      floorsCovered: levels.filter((l) => (levelCovered.get(l) ?? 0) >= 0.95).length,
      kits: kits.length,
      scannedBefore: { coveredPct: 0, maxS: null },
      scannedAfter: { coveredPct: Math.round(after * 10) / 10, maxS: maxes.length ? Math.max(...maxes) : null },
    },
  };
}

export function assumptions(input: PlanInput, rules: RuleOptions, targetS = TARGET_S): string[] {
  return [
    `Target: every point within ${targetS} s walking of a kit at ${WALK_MPS} m/s.`,
    "Scanned floors: walkable points are the Matterport scan points; neighbours within 4 m are linked, path length = straight line × 1.15.",
    "Scan axes are taken as north-up for the side-of-floor words; the elevator core is assumed near the middle of each floor.",
    `Unscanned floors: one kit by the core per floor with ≥ ${rules.denseThreshold} people, else one per ${rules.groupSize} floors on the middle floor; ${rules.stairSecondsPerFloor} s per floor by stairs; ${coreReachS(input.building)} s from the core to the far corner (from CoStar's typical floor size).`,
    "People per floor = current CoStar tenants' employee counts, split by the square feet each occupies per floor. Unknown tenants and visitors are not counted.",
    "Pickup points: Vexcel footprint edges within 15 m of the parcel line are treated as street-facing (Vexcel's detector found no entrances from straight above).",
    "Map pins are spread inside the footprint for clicking; the floor and spot are in the written directions.",
  ];
}

/** Places the map positions once the kit list is final (pins fan out inside the footprint). */
export function placePins(input: PlanInput, kits: KitPlacement[]): KitPlacement[] {
  return kits.map((k, i) => ({ ...k, at: kitLatLng(input, i, kits.length) }));
}

/** The deterministic plan (no model): scanned floors greedy, the rest by the core rule, all street-facing pickups. */
export function planBuilding(input: PlanInput, rules: RuleOptions = DEFAULT_RULES): Plan {
  const scanned = planScanned(input);
  const scannedLevels = input.graphs.map((g) => g.level).filter((l): l is number => l != null);
  const kits = placePins(input, [...scanned, ...planCore(input, scannedLevels, rules)].sort((a, z) => (a.level ?? 0) - (z.level ?? 0)));
  const ev = evaluate(input, kits, rules);
  return {
    propertyId: input.building.propertyId,
    building: input.building.name,
    kits,
    pickups: pickupCandidates(input.aerial),
    coverage: ev.coverage,
    stats: ev.stats,
    assumptions: assumptions(input, rules),
    reasons: [],
    committed: false,
    summary: "",
  };
}

/** One kit by the core on `level`, serving `serves` by the stairs (agent-chosen). */
export function coreKit(input: PlanInput, level: number, serves: number[], rules: RuleOptions, reason?: string): KitPlacement {
  const b = input.building;
  const people = serves.reduce((s, l) => s + peopleOn(b, l), 0);
  const worst = coreReachS(b) + rules.stairSecondsPerFloor * Math.max(0, ...serves.map((l) => Math.abs(l - level)));
  const others = serves.filter((l) => l !== level);
  return {
    id: `core-L${level}`,
    level,
    floorLabel: levelName(level),
    source: "core-rule",
    modelId: null,
    panoId: null,
    position: null,
    at: { lat: 0, lng: 0 },
    directions: `${levelName(level)}, elevator lobby by the core, beside the stair door${others.length ? `; also serves ${others.map(levelName).join(", ")} by the stairs` : ""}.`,
    servesLevels: serves,
    people,
    reason: reason ?? `${people} people; est. worst walk ${worst} s.`,
  };
}

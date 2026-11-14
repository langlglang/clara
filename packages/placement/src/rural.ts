import { projector } from "./geo.js";
import type { LatLng } from "./types.js";

/**
 * Rural placement: with K boxes for a spread-out area, put each box at the population-weighted centre of the
 * people it serves, so the most people have the shortest trip to a box. This is weighted k-median: assign every
 * settlement to its nearest box, move each box to the weighted geometric median of its settlements (Weiszfeld),
 * repeat. Several seeded starts (k-means++ style); the lowest total person-distance wins.
 *
 * A centre can land in a field, so each box also names the nearest settlement as its host site (a store, school or
 * church there), and reports how far that is from the centre. Distances are straight-line × a road factor.
 */

export interface Settlement {
  name: string;
  at: LatLng;
  people: number;
}

export interface RuralBox {
  id: string;
  /** Population-weighted centre of the settlements it serves. */
  centre: LatLng;
  /** Nearest settlement to the centre: where to actually mount it. */
  host: string;
  hostAt: LatLng;
  hostOffsetKm: number;
  serves: string[];
  people: number;
  /** People-weighted average and worst road distance from a served settlement to the host site (km). */
  meanKm: number;
  worstKm: number;
}

export interface RuralPlan {
  boxes: RuralBox[];
  totalPeople: number;
  /** People within `reachKm` of a box's host site. */
  peopleWithin: number;
  reachKm: number;
  meanKm: number;
  assumptions: string[];
}

export const ROAD_FACTOR = 1.3;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function planRural(settlements: Settlement[], k: number, opts: { reachKm?: number; starts?: number } = {}): RuralPlan {
  const reachKm = opts.reachKm ?? 10;
  const pts = settlements.filter((s) => s.people > 0);
  const totalPeople = pts.reduce((a, s) => a + s.people, 0);
  const empty: RuralPlan = { boxes: [], totalPeople, peopleWithin: 0, reachKm, meanKm: 0, assumptions: [] };
  if (!pts.length || k < 1) return empty;
  const K = Math.min(Math.floor(k), pts.length);
  const origin = { lat: pts.reduce((a, s) => a + s.at.lat, 0) / pts.length, lng: pts.reduce((a, s) => a + s.at.lng, 0) / pts.length };
  const pr = projector(origin);
  const xy = pts.map((s) => pr.toXY([s.at.lng, s.at.lat]));
  const w = pts.map((s) => s.people);
  const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const assign = (c: [number, number][]) => xy.map((p) => c.reduce((bi, q, i) => (d(p, q) < d(p, c[bi]) ? i : bi), 0));
  const cost = (c: [number, number][], a: number[]) => xy.reduce((s, p, i) => s + w[i] * d(p, c[a[i]]), 0);

  /** Weighted geometric median (Weiszfeld), starting at the weighted mean. */
  const median = (idx: number[]): [number, number] => {
    const W = idx.reduce((s, i) => s + w[i], 0);
    let m: [number, number] = [idx.reduce((s, i) => s + w[i] * xy[i][0], 0) / W, idx.reduce((s, i) => s + w[i] * xy[i][1], 0) / W];
    for (let it = 0; it < 100; it++) {
      let nx = 0, ny = 0, den = 0;
      for (const i of idx) {
        const dist = Math.max(1, d(xy[i], m));
        nx += (w[i] * xy[i][0]) / dist;
        ny += (w[i] * xy[i][1]) / dist;
        den += w[i] / dist;
      }
      const next: [number, number] = [nx / den, ny / den];
      if (d(next, m) < 0.5) return next;
      m = next;
    }
    return m;
  };

  let best: { c: [number, number][]; a: number[]; cost: number } | null = null;
  const starts = opts.starts ?? 8;
  for (let s = 0; s < starts; s++) {
    const rand = rng(1234 + s * 7919);
    // Seeding: first centre by population, the rest far from the chosen ones (weighted by people × distance²).
    const pick = (score: number[]) => {
      const tot = score.reduce((a, b) => a + b, 0);
      let r = rand() * tot;
      for (let i = 0; i < score.length; i++) if ((r -= score[i]) <= 0) return i;
      return score.length - 1;
    };
    const c: [number, number][] = [xy[pick(w)]];
    while (c.length < K) c.push(xy[pick(xy.map((p, i) => w[i] * Math.min(...c.map((q) => d(p, q))) ** 2))]);
    let a = assign(c);
    for (let it = 0; it < 50; it++) {
      for (let j = 0; j < K; j++) {
        const idx = a.map((v, i) => (v === j ? i : -1)).filter((i) => i >= 0);
        if (idx.length) c[j] = median(idx);
      }
      const na = assign(c);
      const same = na.every((v, i) => v === a[i]);
      a = na;
      if (same) break;
    }
    const total = cost(c, a);
    if (!best || total < best.cost) best = { c: c.map((p) => [...p] as [number, number]), a, cost: total };
  }

  const { c, a } = best!;
  const toLL = (p: [number, number]) => pr.toLatLng(p[0], p[1]);
  // Host site per box: the settlement nearest its centre; then reassign people to the nearest host.
  const hosts = c.map((q) => xy.reduce((bi, p, i) => (d(p, q) < d(xy[bi], q) ? i : bi), 0));
  const near = xy.map((p) => hosts.reduce((bj, h, j) => (d(p, xy[h]) < d(p, xy[hosts[bj]]) ? j : bj), 0));
  let within = 0, sumKm = 0;
  const boxes: RuralBox[] = c.map((q, j) => {
    const idx = near.map((v, i) => (v === j ? i : -1)).filter((i) => i >= 0);
    const km = idx.map((i) => (d(xy[i], xy[hosts[j]]) * ROAD_FACTOR) / 1000);
    const people = idx.reduce((s, i) => s + w[i], 0);
    idx.forEach((i, n) => {
      sumKm += w[i] * km[n];
      if (km[n] <= reachKm) within += w[i];
    });
    return {
      id: `rural-${j + 1}`,
      centre: toLL(q),
      host: pts[hosts[j]].name,
      hostAt: pts[hosts[j]].at,
      hostOffsetKm: Math.round(d(q, xy[hosts[j]]) / 100) / 10,
      serves: idx.map((i) => pts[i].name),
      people,
      meanKm: people ? Math.round((10 * idx.reduce((s, i, n) => s + w[i] * km[n], 0)) / people) / 10 : 0,
      worstKm: km.length ? Math.round(10 * Math.max(...km)) / 10 : 0,
    };
  });
  return {
    boxes: boxes.filter((b) => b.people > 0).sort((x, y) => y.people - x.people),
    totalPeople,
    peopleWithin: within,
    reachKm,
    meanKm: totalPeople ? Math.round((10 * sumKm) / totalPeople) / 10 : 0,
    assumptions: [
      `Each box sits at the population-weighted centre (geometric median) of the settlements nearest to it, then is mounted at the settlement closest to that centre.`,
      `Road distance = straight line × ${ROAD_FACTOR}. "Within reach" = ${reachKm} km by road.`,
      `People per settlement are as entered; everyone in a settlement is counted at its centre point.`,
    ],
  };
}

/** A fictional rural county for the demo (made-up names and counts). */
export const DEMO_RURAL: Settlement[] = [
  { name: "Millbrook", at: { lat: 40.12, lng: -77.2 }, people: 1800 },
  { name: "Cedar Fork", at: { lat: 40.18, lng: -77.31 }, people: 420 },
  { name: "Hollow Creek", at: { lat: 40.05, lng: -77.12 }, people: 260 },
  { name: "Stone Ridge", at: { lat: 40.22, lng: -77.05 }, people: 950 },
  { name: "Pine Gap", at: { lat: 40.3, lng: -77.18 }, people: 150 },
  { name: "Ashby", at: { lat: 40.0, lng: -77.3 }, people: 610 },
  { name: "Elk Run", at: { lat: 40.27, lng: -77.36 }, people: 90 },
  { name: "Two Bridges", at: { lat: 40.09, lng: -76.98 }, people: 540 },
  { name: "Larkfield", at: { lat: 40.15, lng: -77.42 }, people: 300 },
  { name: "Orchard Hill", at: { lat: 40.35, lng: -77.02 }, people: 210 },
];

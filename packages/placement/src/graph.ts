import type { Pano, ScanFloor } from "./types.js";

/**
 * A walking graph per scanned floor from Matterport pano positions: panos are where the camera stood, so they lie on
 * walkable floor. Panos closer than LINK_M are joined; separate clusters are then joined at their closest pair (a
 * scan's capture path is connected). Edge cost is straight-line metres × DETOUR.
 */

export const WALK_MPS = 1.2;
export const TARGET_S = 90;
export const LINK_M = 4;
export const DETOUR = 1.15;

export interface FloorGraph {
  modelId: string;
  modelName: string;
  floorId: string;
  level: number | null;
  label: string;
  nodes: Pano[];
  edges: [number, number, number][];
  /** All-pairs walking metres (Infinity when unreachable). */
  dist: Float64Array;
  extent: { minX: number; minY: number; maxX: number; maxY: number };
}

const d2 = (a: Pano, b: Pano) => Math.hypot(a.x - b.x, a.y - b.y);

export function buildFloorGraph(floor: ScanFloor, meta: { modelId: string; modelName: string; level: number | null; label?: string }, linkM = LINK_M): FloorGraph {
  const nodes = floor.panos;
  const n = nodes.length;
  const edges: [number, number, number][] = [];
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => {
    edges.push([i, j, d2(nodes[i], nodes[j]) * DETOUR]);
    parent[find(i)] = find(j);
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(nodes[i].z - nodes[j].z) < 1.2 && d2(nodes[i], nodes[j]) <= linkM) join(i, j);
  // Join clusters at their closest pair until one remains (Kruskal over the remaining pairs).
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (find(i) !== find(j)) pairs.push([i, j, d2(nodes[i], nodes[j])]);
  pairs.sort((a, b) => a[2] - b[2]);
  for (const [i, j] of pairs) if (find(i) !== find(j)) join(i, j);

  const adj: [number, number][][] = nodes.map(() => []);
  for (const [i, j, w] of edges) {
    adj[i].push([j, w]);
    adj[j].push([i, w]);
  }
  const dist = new Float64Array(n * n).fill(Infinity);
  for (let s = 0; s < n; s++) {
    const d = dijkstra(adj, [s]);
    for (let t = 0; t < n; t++) dist[s * n + t] = d[t];
  }
  const xs = nodes.map((p) => p.x), ys = nodes.map((p) => p.y);
  return {
    modelId: meta.modelId,
    modelName: meta.modelName,
    floorId: floor.id,
    level: meta.level,
    label: meta.label ?? floor.label,
    nodes,
    edges,
    dist,
    extent: n ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

function dijkstra(adj: [number, number][][], sources: number[]): Float64Array {
  const n = adj.length;
  const d = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  for (const s of sources) d[s] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u === -1 || d[i] < d[u])) u = i;
    if (u === -1 || d[u] === Infinity) break;
    done[u] = 1;
    for (const [v, w] of adj[u]) if (d[u] + w < d[v]) d[v] = d[u] + w;
  }
  return d;
}

/** Walking seconds from every pano to its nearest kit (kits are node indices). */
export function walkTimes(g: FloorGraph, kits: number[], speed = WALK_MPS): number[] {
  const n = g.nodes.length;
  return g.nodes.map((_, t) => {
    let best = Infinity;
    for (const k of kits) best = Math.min(best, g.dist[k * n + t]);
    return best / speed;
  });
}

export interface CoverageResult {
  coveredPct: number;
  meanS: number | null;
  maxS: number | null;
  times: (number | null)[];
}

export function coverage(g: FloorGraph, kits: number[], targetS = TARGET_S): CoverageResult {
  if (g.nodes.length === 0) return { coveredPct: 100, meanS: null, maxS: null, times: [] };
  if (kits.length === 0) return { coveredPct: 0, meanS: null, maxS: null, times: g.nodes.map(() => null) };
  const t = walkTimes(g, kits);
  const finite = t.filter(Number.isFinite);
  return {
    coveredPct: Math.round((1000 * t.filter((x) => x <= targetS).length) / t.length) / 10,
    meanS: finite.length ? Math.round(finite.reduce((a, b) => a + b, 0) / finite.length) : null,
    maxS: finite.length ? Math.round(Math.max(...finite)) : null,
    times: t.map((x) => (Number.isFinite(x) ? Math.round(x) : null)),
  };
}

/**
 * Greedy placement: add the pano that covers the most still-uncovered weight within the target; ties go to the one
 * with the lowest worst-case time (central spots, usually by the core). Stops when everything is covered.
 */
export function greedyKits(g: FloorGraph, opts: { targetS?: number; weights?: number[]; maxKits?: number; start?: number[] } = {}): number[] {
  const n = g.nodes.length;
  if (n === 0) return [];
  const targetM = (opts.targetS ?? TARGET_S) * WALK_MPS;
  const w = opts.weights ?? g.nodes.map(() => 1);
  const kits = [...(opts.start ?? [])];
  const covered = (i: number) => kits.some((k) => g.dist[k * n + i] <= targetM);
  while (kits.length < (opts.maxKits ?? 8)) {
    const open = g.nodes.map((_, i) => i).filter((i) => !covered(i));
    if (open.length === 0) break;
    let best = -1, bestGain = -1, bestWorst = Infinity;
    for (let c = 0; c < n; c++) {
      if (kits.includes(c)) continue;
      let gain = 0, worst = 0;
      for (const i of open) if (g.dist[c * n + i] <= targetM) gain += w[i];
      for (let i = 0; i < n; i++) {
        const m = Math.min(g.dist[c * n + i], ...kits.map((k) => g.dist[k * n + i]));
        if (m > worst) worst = m;
      }
      if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && worst < bestWorst)) {
        best = c;
        bestGain = gain;
        bestWorst = worst;
      }
    }
    if (best === -1 || bestGain <= 0) break;
    kits.push(best);
  }
  return kits;
}

/** A compact view of a graph for the UI and the agent. */
export function graphView(g: FloorGraph) {
  return {
    modelId: g.modelId,
    modelName: g.modelName,
    level: g.level,
    label: g.label,
    nodes: g.nodes.map((p) => ({ id: p.id, label: p.label, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 })),
    edges: g.edges.map(([i, j]) => [i, j] as [number, number]),
    extent: g.extent,
  };
}

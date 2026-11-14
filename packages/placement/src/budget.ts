import { TARGET_S, WALK_MPS, type FloorGraph } from "./graph.js";
import { coreKit, coreReachS, DEFAULT_RULES, scanKit, type PlanInput, type RuleOptions } from "./planner.js";
import type { KitPlacement } from "./types.js";

/**
 * Box budget: "this building can take at most K boxes". Instead of placing as many boxes as full coverage needs,
 * choose the K spots that put the most people within the walking target (a maximum-coverage problem).
 *
 * Demand: every scan point on a scanned floor (that floor's people split evenly across its points) and every
 * unscanned floor as one point (its people). Candidate spots: every scan point (covers its own floor's walking
 * graph) and the elevator core of every unscanned floor (covers floors by the stairs).
 *
 * Solver: greedy (best gain first, which is within 1 − 1/e of optimal for coverage), then swap search: take each
 * placed box out, put the best spot back in, keep it if the score rose, until no swap helps. A small bonus for
 * shorter walks breaks ties and spreads boxes when the budget can't cover everyone.
 */

export interface BudgetResult {
  kits: KitPlacement[];
  /** Boxes used (≤ budget; fewer when everyone is already covered). */
  used: number;
  budget: number;
  /** Boxes the same solver needs to cover everyone it can reach (unconstrained). */
  neededForFull: number;
  peopleCovered: number;
  totalPeople: number;
  swaps: number;
}

type Block =
  | { kind: "scan"; g: FloorGraph; w: number[]; level: number }
  | { kind: "core"; levels: number[]; w: number[]; reach: number; stairS: number };

const peopleOn = (input: PlanInput, level: number) => input.building.floors.filter((f) => f.level === level).reduce((s, f) => s + f.people, 0);

function blocks(input: PlanInput, rules: RuleOptions): Block[] {
  const out: Block[] = [];
  const scanned = new Set<number>();
  for (const g of input.graphs) {
    if (g.level == null || g.nodes.length === 0) continue;
    scanned.add(g.level);
    // Empty floors still count a little, so every floor gets some cover when the budget allows.
    const people = Math.max(1, peopleOn(input, g.level));
    out.push({ kind: "scan", g, level: g.level, w: g.nodes.map(() => people / g.nodes.length) });
  }
  const levels = [...new Set(input.building.floors.map((f) => f.level).filter((l): l is number => l != null && !scanned.has(l)))].sort((a, z) => a - z);
  if (levels.length) out.push({ kind: "core", levels, w: levels.map((l) => Math.max(1, peopleOn(input, l))), reach: coreReachS(input.building), stairS: rules.stairSecondsPerFloor });
  return out;
}

const size = (b: Block) => (b.kind === "scan" ? b.g.nodes.length : b.levels.length);
/** Walking seconds from candidate spot c to demand point i in the same block. */
const time = (b: Block, c: number, i: number) => (b.kind === "scan" ? b.g.dist[c * b.g.nodes.length + i] / WALK_MPS : b.reach + b.stairS * Math.abs(b.levels[c] - b.levels[i]));

export function optimizeBudget(input: PlanInput, budget: number, rules: RuleOptions = DEFAULT_RULES, targetS = TARGET_S): BudgetResult {
  const bs = blocks(input, rules);
  const credit = (t: number) => (t <= targetS ? 1 : 0) + 0.001 * Math.max(0, 1 - t / (3 * targetS));
  const best = bs.map((b) => new Float64Array(size(b)).fill(Infinity));
  const placed: { b: number; c: number }[] = [];

  const blockScore = (bi: number, arr: Float64Array) => bs[bi].w.reduce((s, w, i) => s + w * credit(arr[i]), 0);
  const addGain = (bi: number, c: number) => {
    const b = bs[bi], cur = best[bi];
    let g = 0;
    for (let i = 0; i < cur.length; i++) {
      const t = time(b, c, i);
      if (t < cur[i]) g += b.w[i] * (credit(t) - credit(cur[i]));
    }
    return g;
  };
  const apply = (bi: number, c: number) => {
    for (let i = 0; i < best[bi].length; i++) best[bi][i] = Math.min(best[bi][i], time(bs[bi], c, i));
  };
  const rebuild = (bi: number) => {
    best[bi].fill(Infinity);
    for (const p of placed) if (p.b === bi) apply(bi, p.c);
  };
  const isPlaced = (bi: number, c: number) => placed.some((p) => p.b === bi && p.c === c);
  const bestAdd = () => {
    let pick: { b: number; c: number; gain: number } | null = null;
    bs.forEach((b, bi) => {
      for (let c = 0; c < size(b); c++) {
        if (isPlaced(bi, c)) continue;
        const gain = addGain(bi, c);
        if (!pick || gain > pick.gain + 1e-12) pick = { b: bi, c, gain };
      }
    });
    return pick as { b: number; c: number; gain: number } | null;
  };
  /** Gains that move someone inside the target (not just the tie-break bonus). */
  const realGain = (g: number) => g >= 0.5 * Math.min(...bs.flatMap((b) => b.w));

  // Unconstrained need: greedy until no spot brings anyone inside the target.
  let neededForFull = 0;
  for (;;) {
    const p = bestAdd();
    if (!p || !realGain(p.gain)) break;
    placed.push(p);
    apply(p.b, p.c);
    neededForFull++;
    if (neededForFull > 500) break;
  }
  placed.length = 0;
  best.forEach((a) => a.fill(Infinity));

  const cap = Math.max(0, Math.floor(budget));
  // Greedy fill up to the budget (never more boxes than full coverage needs).
  while (placed.length < Math.min(cap, neededForFull || cap)) {
    const p = bestAdd();
    if (!p || p.gain <= 0) break;
    placed.push({ b: p.b, c: p.c });
    apply(p.b, p.c);
  }

  // Swap search.
  let swaps = 0;
  for (let pass = 0, improved = true; improved && pass < 20; pass++) {
    improved = false;
    for (let k = 0; k < placed.length; k++) {
      const out = placed[k];
      const before = bs.reduce((s, _, bi) => s + blockScore(bi, best[bi]), 0);
      placed.splice(k, 1);
      rebuild(out.b);
      const p = bestAdd();
      if (p && !(p.b === out.b && p.c === out.c)) {
        const after = bs.reduce((s, _, bi) => s + blockScore(bi, best[bi]), 0) + p.gain;
        if (after > before + 1e-9) {
          placed.splice(k, 0, { b: p.b, c: p.c });
          apply(p.b, p.c);
          swaps++;
          improved = true;
          continue;
        }
      }
      placed.splice(k, 0, out);
      apply(out.b, out.c);
    }
  }

  // Turn spots into kits; each core kit serves the unscanned floors nearest to it.
  const kits: KitPlacement[] = [];
  let peopleCovered = 0;
  bs.forEach((b, bi) => {
    const mine = placed.filter((p) => p.b === bi).map((p) => p.c);
    if (b.kind === "scan") {
      const n = b.g.nodes.length;
      const covered = best[bi].filter((t) => t <= targetS).length;
      peopleCovered += (peopleOn(input, b.level) * covered) / n;
      const worst = Math.max(...best[bi]);
      mine.forEach((c, k) =>
        kits.push(scanKit(input, b.g, c, mine.length, `Budget pick ${k + 1}/${mine.length} on this floor: ${Math.round((100 * covered) / n)}% of scan points within ${targetS} s (worst ${Number.isFinite(worst) ? Math.round(worst) : "∞"} s).`)),
      );
    } else {
      const serves = new Map<number, number[]>(mine.map((c) => [c, []]));
      b.levels.forEach((l, i) => {
        if (!mine.length) return;
        const near = mine.reduce((a, c) => (time(b, c, i) < time(b, a, i) ? c : a));
        serves.get(near)!.push(l);
        if (best[bi][i] <= targetS) peopleCovered += peopleOn(input, l);
      });
      for (const c of mine) {
        const s = serves.get(c)!;
        const inside = s.filter((l) => time(b, c, b.levels.indexOf(l)) <= targetS);
        kits.push(coreKit(input, b.levels[c], s, rules, `Budget pick by the core: ${inside.length}/${s.length} of the floors it serves within ${targetS} s (${b.reach} s across a floor + ${b.stairS} s per floor by stairs).`));
      }
    }
  });
  return {
    kits: kits.sort((a, z) => (a.level ?? 0) - (z.level ?? 0)),
    used: placed.length,
    budget: cap,
    neededForFull,
    peopleCovered: Math.round(peopleCovered),
    totalPeople: input.building.totalPeople,
    swaps,
  };
}

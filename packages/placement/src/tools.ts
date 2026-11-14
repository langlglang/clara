import { coverage, graphView, greedyKits, TARGET_S, type FloorGraph } from "./graph.js";
import { assumptions, coreKit, DEFAULT_RULES, evaluate, pickupCandidates, placePins, planCore, scanKit, type PlanInput, type RuleOptions } from "./planner.js";
import type { KitPlacement, PickupPoint, Plan } from "./types.js";
import { optimizeBudget } from "./budget.js";

/**
 * The planner's tool layer: the only way the agent (or the deterministic fallback) reads data and changes the plan.
 * Every call is logged for the admin page. Data is loaded before the session starts, so tools are synchronous.
 */

export interface ToolLogEntry {
  at: string;
  tool: string;
  args: string;
  ok: boolean;
  result: string;
}

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export interface KitSpec {
  level: number;
  /** Scan point id on that level's scan (scanned floors); omitted = by the core (unscanned floors). */
  pano_id?: string;
  serves_levels?: number[];
  reason?: string;
}

const short = (v: unknown, n = 400) => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function createPlannerSession(input: PlanInput, opts: { onLog?: (e: ToolLogEntry) => void; now?: () => Date; maxKits?: number } = {}) {
  const maxKits = opts.maxKits && opts.maxKits > 0 ? Math.floor(opts.maxKits) : null;
  const log: ToolLogEntry[] = [];
  const now = opts.now ?? (() => new Date());
  let rules: RuleOptions = { ...DEFAULT_RULES };
  let kits: KitPlacement[] = [];
  let pickups: PickupPoint[] = [];
  let plan: Plan | null = null;
  const reasons: string[] = [];
  const graphFor = (level: number): FloorGraph | undefined => input.graphs.find((g) => g.level === level);
  const scannedLevels = () => input.graphs.map((g) => g.level).filter((l): l is number => l != null);

  const record = (tool: string, args: unknown, r: ToolResult): ToolResult => {
    const e = { at: now().toISOString(), tool, args: short(args ?? {}, 200), ok: r.ok, result: short(r) };
    log.push(e);
    opts.onLog?.(e);
    return r;
  };

  function toKits(specs: KitSpec[]): { kits: KitPlacement[]; errors: string[] } {
    const out: KitPlacement[] = [];
    const errors: string[] = [];
    for (const s of specs) {
      const g = graphFor(s.level);
      if (s.pano_id) {
        if (!g) {
          errors.push(`level ${s.level} has no scan`);
          continue;
        }
        const idx = g.nodes.findIndex((n) => n.id === s.pano_id);
        if (idx < 0) {
          errors.push(`pano ${s.pano_id} is not on level ${s.level}'s scan`);
          continue;
        }
        out.push(scanKit(input, g, idx, specs.filter((x) => x.level === s.level).length, s.reason ?? "Chosen by the planner."));
      } else {
        const serves = s.serves_levels?.length ? s.serves_levels : [s.level];
        out.push(coreKit(input, s.level, serves, rules, s.reason));
      }
    }
    return { kits: out, errors };
  }

  const tools = {
    get_building(): ToolResult {
      const b = input.building;
      return record("get_building", {}, {
        ok: true,
        name: b.name,
        address: `${b.address}, ${b.city} ${b.state}`.trim(),
        stories: b.stories,
        rentable_sqft: b.rentableSqft,
        typical_floor_sqft: b.typicalFloorSqft,
        property_type: b.propertyType,
        year_built: b.yearBuilt,
        total_people: b.totalPeople,
        top_tenants: b.topTenants.slice(0, 6).map((t) => `${t.name} (${t.employees}, floors ${t.floors.join("/")})`),
        scanned_levels: input.graphs.map((g) => ({ level: g.level, scan: g.modelName, points: g.nodes.length })),
        source: b.source,
        box_budget: maxKits,
      });
    },
    people_by_floor(): ToolResult {
      const floors = input.building.floors.filter((f) => f.people > 0 || f.level != null).map((f) => ({ level: f.level, name: f.name, people: f.people, tenants: f.tenants, scanned: f.level != null && scannedLevels().includes(f.level) }));
      return record("people_by_floor", {}, { ok: true, floors, dense_threshold: rules.denseThreshold });
    },
    get_floor_graph(a: { level: number }): ToolResult {
      const g = graphFor(a.level);
      if (!g) return record("get_floor_graph", a, { ok: false, error: `No scan for level ${a.level}. Scanned levels: ${scannedLevels().join(", ") || "none"}.` });
      const v = graphView(g);
      // The greedy suggestion, so the agent can start from it and argue changes.
      const suggest = greedyKits(g);
      return record("get_floor_graph", a, {
        ok: true,
        scan: g.modelName,
        points: v.nodes.length,
        links: v.edges.length,
        extent_m: { x: Math.round(g.extent.maxX - g.extent.minX), y: Math.round(g.extent.maxY - g.extent.minY) },
        greedy_suggestion: suggest.map((i) => ({ pano_id: g.nodes[i].id, x: v.nodes[i].x, y: v.nodes[i].y })),
        sample_points: v.nodes.filter((_, i) => i % Math.max(1, Math.ceil(v.nodes.length / 25)) === 0).map((n) => ({ pano_id: n.id, x: n.x, y: n.y })),
      });
    },
    get_aerial(): ToolResult {
      const a = input.aerial;
      if (!a) return record("get_aerial", {}, { ok: false, error: "No Vexcel aerial data for this building." });
      return record("get_aerial", {}, { ok: true, footprint_m2: a.footprintAreaM2, roof_height_m: a.roofHeightM, capture_date: a.captureDate, gsd_m: a.gsdM, pickup_candidates: pickupCandidates(a).map((p) => ({ facing: p.facing, edge_m: p.edgeLengthM, note: p.note })) });
    },
    evaluate_coverage(a: { kits?: KitSpec[] }): ToolResult {
      const t = a.kits ? toKits(a.kits) : { kits, errors: [] };
      const ev = evaluate(input, t.kits, rules);
      return record("evaluate_coverage", { kits: a.kits ? `${a.kits.length} kits` : "current proposal" }, {
        ok: true,
        errors: t.errors,
        scanned_floors: ev.coverage.map((c) => ({ level: c.level, kits: c.kits, covered_pct: c.coveredPct, mean_s: c.meanS, worst_s: c.maxS })),
        ...ev.stats,
      });
    },
    propose_kits(a: { mode: "auto" | "manual" | "budget"; kits?: KitSpec[]; dense_threshold?: number; group_size?: number; max_kits?: number; reason?: string }): ToolResult {
      let budgetInfo: Record<string, unknown> = {};
      if (a.dense_threshold != null) rules.denseThreshold = Math.max(10, Math.min(2000, Math.round(a.dense_threshold)));
      if (a.group_size != null) rules.groupSize = Math.max(1, Math.min(5, Math.round(a.group_size)));
      if (a.mode === "manual") {
        if (!a.kits?.length) return record("propose_kits", a, { ok: false, error: "manual mode needs kits" });
        const t = toKits(a.kits);
        if (t.errors.length) return record("propose_kits", a, { ok: false, error: t.errors.join("; ") });
        kits = t.kits;
        if (maxKits != null && kits.length > maxKits) return record("propose_kits", a, { ok: false, error: `${kits.length} kits is over the building's budget of ${maxKits} boxes.` });
      } else if (a.mode === "budget") {
        const k = Math.min(maxKits ?? Infinity, a.max_kits ?? maxKits ?? Infinity);
        if (!Number.isFinite(k)) return record("propose_kits", a, { ok: false, error: "budget mode needs max_kits (no building budget set)" });
        const r = optimizeBudget(input, k, rules);
        kits = r.kits;
        budgetInfo = { budget: r.budget, used: r.used, needed_for_full: r.neededForFull, swaps: r.swaps };
      } else {
        const scanned: KitPlacement[] = [];
        for (const g of input.graphs) {
          const idx = greedyKits(g, { targetS: TARGET_S });
          const c = coverage(g, idx);
          idx.forEach((i) => scanned.push(scanKit(input, g, i, idx.length, `Greedy on ${g.nodes.length} scan points: all within ${TARGET_S} s (worst ${c.maxS} s).`)));
        }
        kits = [...scanned, ...planCore(input, scannedLevels(), rules)];
      }
      kits = placePins(input, kits.sort((x, z) => (x.level ?? 0) - (z.level ?? 0)));
      if (a.reason) reasons.push(a.reason);
      const ev = evaluate(input, kits, rules);
      return record("propose_kits", { ...a, kits: a.kits ? `${a.kits.length} kits` : undefined }, { ok: true, rules, ...budgetInfo, ...ev.stats });
    },
    set_pickup_points(a: { facings: string[]; reason?: string }): ToolResult {
      const all = pickupCandidates(input.aerial);
      pickups = all.filter((p) => a.facings.includes(p.facing));
      if (a.reason) reasons.push(a.reason);
      return record("set_pickup_points", a, { ok: true, pickups: pickups.map((p) => p.note), available: all.map((p) => p.facing) });
    },
    commit_plan(a: { summary: string; reasons?: string[] }): ToolResult {
      if (kits.length === 0) return record("commit_plan", a, { ok: false, error: "Propose kits first." });
      if (maxKits != null && kits.length > maxKits) return record("commit_plan", a, { ok: false, error: `${kits.length} kits is over the budget of ${maxKits}; use propose_kits mode "budget".` });
      const ev = evaluate(input, kits, rules);
      reasons.push(...(a.reasons ?? []).slice(0, 8));
      plan = {
        propertyId: input.building.propertyId,
        building: input.building.name,
        kits,
        pickups,
        coverage: ev.coverage,
        stats: ev.stats,
        assumptions: [...assumptions(input, rules), ...(maxKits != null ? [`Box budget: at most ${maxKits} boxes; spots chosen to put the most people within the target (greedy max-coverage plus swap search).`] : [])],
        reasons: reasons.map((r) => r.slice(0, 300)),
        committed: true,
        summary: String(a.summary ?? "").slice(0, 600),
      };
      return record("commit_plan", { summary: a.summary }, { ok: true, pickups: pickups.length, ...ev.stats });
    },
  };

  return {
    tools,
    log,
    plan: () => plan,
    draft: () => ({ kits, pickups, rules }),
    maxKits,
  };
}

export type PlannerSession = ReturnType<typeof createPlannerSession>;

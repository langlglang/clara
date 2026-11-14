import { fileCache, type Cache } from "./cache.js";
import { costarReader, DEMO_BUILDINGS, demoSummary } from "./costar.js";
import { buildFloorGraph, type FloorGraph } from "./graph.js";
import { levelFromScanName, matterportClient } from "./matterport.js";
import { planBuilding, type PlanInput } from "./planner.js";
import { createPlannerSession, type ToolLogEntry } from "./tools.js";
import { runAgent, runFallback } from "./agent.js";
import { vexcelClient } from "./vexcel.js";
import type { BuildingIndexEntry, BuildingSummary, Fetch, Plan } from "./types.js";

export * from "./types.js";
export * from "./cache.js";
export * from "./costar.js";
export * from "./geo.js";
export * from "./graph.js";
export * from "./matterport.js";
export * from "./vexcel.js";
export * from "./planner.js";
export * from "./tools.js";
export * from "./agent.js";

export interface PlacementEnv {
  COSTAR_DATA_DIR?: string;
  MP_API_KEY?: string;
  MP_API_TOKEN?: string;
  VEXCEL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CLARA_PLANNER?: string;
  CLARA_PLANNER_MODEL?: string;
  CLARA_COORDINATOR_MODEL?: string;
}

/** A scan the planner uses as a floor (a whole-floor capture), or why it was skipped. */
export interface ScanInfo {
  modelId: string;
  name: string;
  level: number | null;
  points: number;
  used: boolean;
  note: string;
}

/** Scans with fewer points than this are single rooms, not floors. */
export const MIN_FLOOR_POINTS = 12;
const MAX_MODELS = 12;

export function createPlacement(env: PlacementEnv, opts: { fetch?: Fetch; cache?: Cache } = {}) {
  const cache = opts.cache ?? fileCache();
  const costar = costarReader(env.COSTAR_DATA_DIR?.trim() || undefined, cache);
  const mp = matterportClient({ key: env.MP_API_KEY?.trim(), token: env.MP_API_TOKEN?.trim(), fetch: opts.fetch, cache });
  const vx = vexcelClient({ apiKey: env.VEXCEL_API_KEY?.trim(), fetch: opts.fetch, cache });
  const agentOn = !!env.ANTHROPIC_API_KEY?.trim() && env.CLARA_PLANNER !== "rules";

  async function searchBuildings(q = ""): Promise<BuildingIndexEntry[]> {
    const list = costar.available ? await costar.index() : DEMO_BUILDINGS;
    const s = q.trim().toLowerCase();
    return (s ? list.filter((b) => `${b.name} ${b.address} ${b.city} ${b.propertyId}`.toLowerCase().includes(s)) : list).slice(0, 40);
  }

  async function building(id: number): Promise<BuildingSummary | null> {
    if (costar.available) return costar.building(id);
    const d = DEMO_BUILDINGS.find((b) => b.propertyId === id);
    return d ? demoSummary(d) : null;
  }

  async function scans(b: BuildingSummary): Promise<{ graphs: FloorGraph[]; info: ScanInfo[] }> {
    const graphs: FloorGraph[] = [];
    const info: ScanInfo[] = [];
    for (const id of b.matterportModels.slice(0, MAX_MODELS)) {
      try {
        const m = await mp.model(id);
        const level = levelFromScanName(m.name);
        for (const f of m.floors) {
          const used = f.panos.length >= MIN_FLOOR_POINTS && level != null;
          info.push({ modelId: id, name: m.name, level, points: f.panos.length, used, note: used ? "floor scan" : level == null ? "level unknown from the scan name" : "single room (too few scan points)" });
          if (used) graphs.push(buildFloorGraph(f, { modelId: id, modelName: m.name, level, label: `Level ${level}` }));
        }
      } catch (e) {
        info.push({ modelId: id, name: id, level: null, points: 0, used: false, note: (e as Error).message.slice(0, 160) });
      }
    }
    // One scan per level: keep the one with the most points.
    const best = new Map<number, FloorGraph>();
    for (const g of graphs) if (!best.has(g.level!) || best.get(g.level!)!.nodes.length < g.nodes.length) best.set(g.level!, g);
    return { graphs: [...best.values()].sort((a, z) => a.level! - z.level!), info };
  }

  async function loadInput(id: number): Promise<{ input: PlanInput; scans: ScanInfo[]; warnings: string[] } | null> {
    const b = await building(id);
    if (!b) return null;
    const warnings: string[] = [];
    if (!costar.available) warnings.push("CoStar extract not available on this server: no people or tenant data; floors from built-in facts.");
    const s = await scans(b).catch((e: Error) => (warnings.push(`Matterport: ${e.message}`), { graphs: [], info: [] }));
    if (!mp.configured) warnings.push("Matterport keys not set: no walking graphs.");
    let aerial = null;
    try {
      aerial = await vx.aerial(b.propertyId, b.location);
    } catch (e) {
      warnings.push(`Vexcel: ${(e as Error).message}`);
    }
    return { input: { building: b, graphs: s.graphs, aerial }, scans: s.info, warnings };
  }

  async function plan(
    input: PlanInput,
    o: { onLog?: (e: ToolLogEntry) => void; onThought?: (t: string) => void; signal?: AbortSignal; useAgent?: boolean } = {},
  ): Promise<{ plan: Plan; mode: "agent" | "fallback"; log: ToolLogEntry[]; error: string | null }> {
    const note = o.onThought ?? (() => {});
    if (agentOn && o.useAgent !== false) {
      const session = createPlannerSession(input, { onLog: o.onLog });
      try {
        const final = await runAgent(session, { apiKey: env.ANTHROPIC_API_KEY, model: env.CLARA_PLANNER_MODEL?.trim() || env.CLARA_COORDINATOR_MODEL?.trim() || undefined, signal: o.signal, onThought: note });
        if (final) note(final.slice(0, 800));
        const p = session.plan();
        if (p) return { plan: p, mode: "agent", log: session.log, error: null };
        note("The agent finished without commit_plan; running the deterministic planner.");
      } catch (e) {
        note(`Agent failed (${(e as Error).message.slice(0, 160)}); running the deterministic planner.`);
      }
      const fb = createPlannerSession(input, { onLog: o.onLog });
      runFallback(fb, note);
      return { plan: fb.plan() ?? planBuilding(input), mode: "fallback", log: [...session.log, ...fb.log], error: "agent did not commit a plan" };
    }
    const session = createPlannerSession(input, { onLog: o.onLog });
    runFallback(session, note);
    return { plan: session.plan() ?? planBuilding(input), mode: "fallback", log: session.log, error: null };
  }

  return {
    cache,
    costar,
    matterport: mp,
    vexcel: vx,
    status: () => ({ costar: costar.available, matterport: mp.configured, vexcel: vx.configured, agent: agentOn }),
    searchBuildings,
    building,
    loadInput,
    plan,
  };
}

export type Placement = ReturnType<typeof createPlacement>;

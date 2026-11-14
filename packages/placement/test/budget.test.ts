import { describe, expect, it } from "vitest";
import { buildFloorGraph, coverage, createPlannerSession, demoSummary, optimizeBudget, runFallback, type BuildingSummary, type ScanFloor } from "../src/index.js";

/** A long corridor (scan points every 4 m): one box covers 108 m each way at 90 s. */
function corridor(lengthM: number): ScanFloor {
  const panos = [];
  for (let x = 0; x <= lengthM; x += 4) panos.push({ id: `p${x}`, label: String(x), x, y: 0, z: 1.5 });
  return { id: "f", label: "F", sequence: 0, panos };
}

const tower = (floors: { level: number; people: number }[]): BuildingSummary => ({
  ...demoSummary({ propertyId: 7, name: "Budget Tower", address: "1 Main", city: "Houston", location: { lat: 29.75, lng: -95.36 }, stories: floors.length, models: [] }),
  floors: floors.map((f) => ({ floorId: null, name: String(f.level), level: f.level, sqft: 20_000, people: f.people, tenants: 1 })),
  totalPeople: floors.reduce((s, f) => s + f.people, 0),
  typicalFloorSqft: 20_000,
});

describe("box budget", () => {
  const g = buildFloorGraph(corridor(1000), { modelId: "m", modelName: "Level 1", level: 1 });
  const input = { building: tower([{ level: 1, people: 500 }]), graphs: [g], aerial: null };

  it("never uses more boxes than the budget, and more budget never covers fewer people", () => {
    let last = -1;
    for (const k of [1, 2, 3, 4]) {
      const r = optimizeBudget(input, k);
      expect(r.kits.length).toBeLessThanOrEqual(k);
      expect(r.peopleCovered).toBeGreaterThanOrEqual(last);
      last = r.peopleCovered;
    }
  });

  it("stops at what full coverage needs when the budget is larger", () => {
    const r = optimizeBudget(input, 50);
    expect(r.used).toBe(r.neededForFull);
    expect(r.peopleCovered).toBe(500);
  });

  it("matches exhaustive search for 2 boxes on one floor", () => {
    const n = g.nodes.length;
    let bestPct = 0;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) bestPct = Math.max(bestPct, coverage(g, [a, b]).coveredPct);
    const r = optimizeBudget(input, 2);
    const idx = r.kits.map((k) => g.nodes.findIndex((p) => p.id === k.panoId));
    expect(coverage(g, idx).coveredPct).toBe(bestPct);
  });

  it("puts a scarce box where the people are (unscanned floors)", () => {
    const b = tower([{ level: 1, people: 10 }, { level: 2, people: 10 }, { level: 8, people: 400 }, { level: 9, people: 400 }]);
    const r = optimizeBudget({ building: b, graphs: [], aerial: null }, 1);
    expect(r.kits).toHaveLength(1);
    expect([8, 9]).toContain(r.kits[0].level);
  });

  it("the planner session honours the building budget end to end", () => {
    const s = createPlannerSession(input, { maxKits: 2 });
    runFallback(s);
    const plan = s.plan()!;
    expect(plan.kits.length).toBeLessThanOrEqual(2);
    expect(plan.assumptions.some((a) => a.includes("Box budget"))).toBe(true);
    expect(s.tools.propose_kits({ mode: "manual", kits: [{ level: 1, pano_id: "p0" }, { level: 1, pano_id: "p400" }, { level: 1, pano_id: "p800" }] }).ok).toBe(false);
  });
});

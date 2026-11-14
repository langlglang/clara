import { describe, expect, it } from "vitest";
import {
  buildFloorGraph, coverage, createPlannerSession, demoSummary, evaluate, greedyKits, levelFromScanName, matterportClient, memoryCache, parseLevel,
  parseProperty, parseWktRings, pickupCandidates, planBuilding, runFallback, summarizePeople, vexcelClient, type Aerial, type BuildingSummary, type Fetch, type ScanFloor,
} from "../src/index.js";

/** A 60 m corridor of scan points every 2 m (y = 0), plus a side room. */
function corridor(lengthM = 60): ScanFloor {
  const panos = [];
  for (let x = 0; x <= lengthM; x += 2) panos.push({ id: `p${x}`, label: String(x), x, y: 0, z: 1.5 });
  panos.push({ id: "room", label: "room", x: 30, y: 3, z: 1.5 });
  return { id: "f1", label: "Floor 1", sequence: 0, panos };
}

const building = (over: Partial<BuildingSummary> = {}): BuildingSummary => ({
  ...demoSummary({ propertyId: 1, name: "Test Tower", address: "1 Main St", city: "Houston", location: { lat: 29.75, lng: -95.36 }, stories: 6, models: ["m1"] }),
  ...over,
});

// A 40 x 40 m square footprint inside a 60 x 60 m parcel (street on every side), around (29.75, -95.36).
const sq = (half: number): [number, number][] => {
  const dLat = half / 110_540, dLng = half / (Math.cos((29.75 * Math.PI) / 180) * 111_320);
  return [[-95.36 - dLng, 29.75 - dLat], [-95.36 + dLng, 29.75 - dLat], [-95.36 + dLng, 29.75 + dLat], [-95.36 - dLng, 29.75 + dLat], [-95.36 - dLng, 29.75 - dLat]];
};
const aerial: Aerial = { parcel: sq(30), footprint: sq(20), footprintAreaM2: 1600, roofHeightM: 200, captureDate: "2025-09-03", gsdM: 0.07, imageBounds: [0, 0, 0, 0], imageFile: null };

describe("geometry and parsing", () => {
  it("parses WKT polygons and multipolygons (outer rings only)", () => {
    expect(parseWktRings("POLYGON ((0 0, 1 0, 1 1, 0 0), (0.1 0.1, 0.2 0.1, 0.1 0.2, 0.1 0.1))")).toHaveLength(1);
    expect(parseWktRings("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))")).toHaveLength(2);
  });
  it("reads levels from floor and scan names", () => {
    expect(parseLevel(53)).toBe(29);
    expect(parseLevel(24)).toBe(1);
    expect(parseLevel("53")).toBe(53);
    expect(parseLevel("LL")).toBe(-1);
    expect(levelFromScanName("1000 Louisiana - Level 53")).toBe(53);
    expect(levelFromScanName("1000 Louisiana Suite 3700")).toBe(37);
    expect(levelFromScanName("1000 Louisiana 1175")).toBe(11);
  });
});

describe("CoStar people per floor", () => {
  it("splits current tenants' employees by occupied area and skips expired tenancies", () => {
    const r = summarizePeople(
      { id: 1, numStoriesAboveGrade: 3, floors: [{ propertyFloorId: 11, floorName: 24 }, { propertyFloorId: 12, floorName: 25 }] },
      [
        { propertyId: 1, tenantLocationId: 100, toDate: null, spaces: [{ propertyFloorId: 11, squareFeetOccupied: 3000 }, { propertyFloorId: 12, squareFeetOccupied: 1000 }] },
        { propertyId: 1, tenantLocationId: 200, toDate: "2019-01-01", expirationReason: 10, spaces: [{ propertyFloorId: 12, squareFeetOccupied: 1000 }] },
      ],
      new Map([[100, { name: "Acme", numEmployees: 80 }], [200, { name: "Gone", numEmployees: 500 }]]),
    );
    expect(r.floors.map((f) => [f.level, f.people])).toEqual([[1, 60], [2, 20], [3, 0]]);
    expect(r.total).toBe(80);
    expect(r.tenants.map((t) => t.name)).toEqual(["Acme"]);
  });
});

describe("walking graph and coverage", () => {
  it("links nearby scan points and measures walking time to the nearest kit", () => {
    const g = buildFloorGraph(corridor(), { modelId: "m1", modelName: "Test Level 3", level: 3 });
    expect(coverage(g, []).coveredPct).toBe(0);
    const end = coverage(g, [0]); // kit at one end: far end is 60 m × 1.15 / 1.2 ≈ 58 s
    expect(end.coveredPct).toBe(100);
    expect(end.maxS).toBeGreaterThan(55);
    const kits = greedyKits(g);
    expect(kits).toHaveLength(1);
    expect(coverage(g, kits).maxS!).toBeLessThan(end.maxS!); // the greedy pick is central
  });
  it("needs more kits on a long floor", () => {
    const g = buildFloorGraph(corridor(240), { modelId: "m1", modelName: "Long", level: 2 });
    const kits = greedyKits(g);
    expect(kits.length).toBeGreaterThanOrEqual(2);
    expect(coverage(g, kits).coveredPct).toBe(100);
  });
});

describe("pickups and plan", () => {
  it("puts one pickup on each street-facing side", () => {
    expect(pickupCandidates(aerial).map((p) => p.facing).sort()).toEqual(["east", "north", "south", "west"]);
  });
  it("plans scanned floors by graph and the rest by the core rule", () => {
    const b = building({ floors: [1, 2, 3, 4, 5, 6].map((l) => ({ floorId: l, name: String(l), level: l, sqft: 20000, people: l === 5 ? 300 : 40, tenants: 1 })), totalPeople: 500 });
    const g = buildFloorGraph(corridor(), { modelId: "m1", modelName: "Test Level 3", level: 3 });
    const plan = planBuilding({ building: b, graphs: [g], aerial });
    expect(plan.kits.filter((k) => k.source === "scan")).toHaveLength(1);
    expect(plan.kits.find((k) => k.level === 5)?.servesLevels).toEqual([5]); // dense floor gets its own kit
    expect(plan.stats.peopleCovered).toBe(500);
    expect(plan.stats.floorsCovered).toBe(6);
    expect(evaluate({ building: b, graphs: [g], aerial }, []).stats.peopleCovered).toBe(0);
  });
  it("the fallback drives the tools to a committed plan", () => {
    const g = buildFloorGraph(corridor(), { modelId: "m1", modelName: "Test Level 3", level: 3 });
    const s = createPlannerSession({ building: building(), graphs: [g], aerial });
    runFallback(s);
    const p = s.plan()!;
    expect(p.committed).toBe(true);
    expect(p.pickups).toHaveLength(2);
    expect(s.log.map((e) => e.tool)).toContain("evaluate_coverage");
    expect(s.tools.get_floor_graph({ level: 9 }).ok).toBe(false);
    expect(s.tools.propose_kits({ mode: "manual", kits: [{ level: 3, pano_id: "nope" }] }).ok).toBe(false);
  });
});

describe("clients (injected fetch, no network)", () => {
  it("Matterport: parses the model and caches it", async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ data: { model: { id: "m1", name: "X Level 4", floors: [{ id: "f", label: "Floor 1", sequence: 0, panoLocations: [{ id: "a", label: "0", position: { x: 1, y: 2, z: 1.5 } }] }], rooms: [] } } }) };
    };
    const mp = matterportClient({ key: "k", token: "t", fetch, cache: memoryCache() });
    const m = await mp.model("m1");
    await mp.model("m1");
    expect(m.floors[0].panos[0]).toMatchObject({ id: "a", x: 1 });
    expect(calls).toBe(1);
  });
  it("Vexcel: picks the newest capture and the largest structure", async () => {
    const body = {
      features: [
        { geometry: { type: "Polygon", coordinates: [aerial.parcel] }, properties: { "metadata.ortho-date-estimate": "2022-01-01", structures: [] } },
        { geometry: { type: "MultiPolygon", coordinates: [[aerial.parcel]] }, properties: { "metadata.ortho-date-estimate": "2025-09-03", structures: [{ "footprint.wkt": `POLYGON ((${aerial.footprint.map((p) => p.join(" ")).join(", ")}))`, "roof-characteristics.maximum-roof-height": 210 }] } },
      ],
    };
    const p = parseProperty(body as never, { lat: 29.75, lng: -95.36 })!;
    expect(p.captureDate).toBe("2025-09-03");
    expect(p.roofHeightM).toBe(210);
    expect(Math.abs(p.footprintAreaM2 - 1600)).toBeLessThan(20);
    const fetch: Fetch = async () => ({ ok: true, status: 200, text: async () => "", arrayBuffer: async () => new ArrayBuffer(4), json: async () => body });
    const vx = vexcelClient({ apiKey: "k", fetch, cache: memoryCache() });
    const a = await vx.aerial(1, { lat: 29.75, lng: -95.36 });
    expect(a.imageFile).toBe("vx-ortho-1.jpg");
  });
});

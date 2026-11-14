import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Cache } from "./cache.js";
import type { BuildingIndexEntry, BuildingSummary, FloorPeople, Tenant } from "./types.js";

/**
 * Reads the local CoStar hackathon extract (COSTAR_DATA_DIR): JSON Lines streamed line by line, filtered by id before
 * parsing. Results are cached as JSON (gitignored); the extract and anything derived from it never go in the repo.
 */

const CACHE_VERSION = 3;

async function* lines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}

const idAtStart = (line: string): number | null => {
  const m = /^\{"id":(\d+),/.exec(line);
  return m ? Number(m[1]) : null;
};

/**
 * CoStar floorName is an enum (schemas/enums.json FloorName): 24 = first floor, 25 = second, 26 = mezzanine, 27..149 =
 * 3rd..125th; 5..14 parking ten..one, 16..20 below grade, 21..23 plaza/lobby/ground. Returns the building level.
 */
export function floorEnumLevel(n: number): number | null {
  if (n >= 27 && n <= 149) return n - 24;
  if (n === 24 || n === 21 || n === 22 || n === 23) return 1;
  if (n === 25) return 2;
  if (n >= 5 && n <= 14) return -(15 - n);
  if (n >= 16 && n <= 20) return -1;
  return null;
}

/** A floor name in words, for the enum (e.g. "Level 29", "Mezzanine"). */
export function floorEnumName(n: number): string {
  const l = floorEnumLevel(n);
  if (n === 26) return "Mezzanine";
  if (n === 150) return "Penthouse";
  if (l == null) return `Floor code ${n}`;
  return l < 0 ? `Parking/basement ${-l}` : `Level ${l}`;
}

/** Floor names: CoStar enum numbers (see floorEnumLevel), or text: "53" → 53, "LL"/"B1" → negative, "Lobby" → 1. */
export function parseLevel(name: unknown): number | null {
  if (typeof name === "number") return floorEnumLevel(name);
  const s = String(name ?? "").trim().toUpperCase();
  if (/^\d+$/.test(s)) return Number(s);
  const b = /^(?:B|P|LL)(\d*)$/.exec(s);
  if (b) return -(Number(b[1] || "1"));
  if (s === "G" || s === "L" || s === "LOBBY" || s === "GROUND") return 1;
  return null;
}

interface RawProperty {
  id: number;
  buildingName?: string;
  primaryAddress?: { buildingName?: string; streetNumber?: string; streetName?: string; streetType?: string; city?: string; state?: string; latitude?: number; longitude?: number };
  propertyType?: number;
  numStoriesAboveGrade?: number;
  rentableBuildingAreaSquareFeet?: number;
  grossTypicalFloorSquareFeet?: number;
  constructionEvents?: { eventType?: number; year?: number }[];
  floors?: { propertyFloorId: number; floorName: unknown; floorSize?: { squareFeet?: number } }[];
}

interface RawOccupancy {
  propertyId: number;
  tenantLocationId: number | null;
  expirationReason?: number | null;
  toDate?: string | null;
  spaces?: { propertyFloorId?: number | null; squareFeetOccupied?: number | null }[];
}

const addressOf = (p: RawProperty) => {
  const a = p.primaryAddress ?? {};
  return [a.streetNumber, a.streetName, a.streetType].filter(Boolean).join(" ");
};

/** Current tenancy: no end date, or expirationReason 0. */
export const isCurrent = (o: RawOccupancy) => o.toDate == null || o.expirationReason === 0;

/** CoStar's Matterport capture list: PropertyId → model ids (commercial-properties.csv). */
export function readCaptureList(dir: string): Map<number, { models: string[]; address: string; city: string }> {
  const out = new Map<number, { models: string[]; address: string; city: string }>();
  const text = readFileSync(join(dir, "commercial-properties.csv"), "utf8");
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [id, model, address, city] = line.split(",");
    const n = Number(id);
    if (!Number.isFinite(n) || !model) continue;
    const e = out.get(n) ?? { models: [], address: address ?? "", city: city ?? "" };
    if (!e.models.includes(model)) e.models.push(model);
    out.set(n, e);
  }
  return out;
}

function propertyTypeNames(dir: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(dir, "schemas", "enums.json"), "utf8")) as Record<string, Record<string, string>>).PropertyType ?? {};
  } catch {
    return {};
  }
}

/** Pure: per-floor people and top tenants from the property's floors, its current occupancies and company sizes. */
export function summarizePeople(
  property: RawProperty,
  occupancies: RawOccupancy[],
  companies: Map<number, { name: string; numEmployees: number | null }>,
): { floors: FloorPeople[]; tenants: Tenant[]; total: number } {
  const floors = new Map<number, FloorPeople>();
  for (const f of property.floors ?? []) {
    const name = typeof f.floorName === "number" ? floorEnumName(f.floorName) : String(f.floorName ?? "?");
    floors.set(f.propertyFloorId, { floorId: f.propertyFloorId, name, level: parseLevel(f.floorName), sqft: f.floorSize?.squareFeet ?? null, people: 0, tenants: 0 });
  }
  const tenants: Tenant[] = [];
  for (const o of occupancies) {
    if (!isCurrent(o) || o.tenantLocationId == null) continue;
    const c = companies.get(o.tenantLocationId);
    if (!c) continue;
    const spaces = (o.spaces ?? []).filter((s) => s.propertyFloorId != null && floors.has(s.propertyFloorId));
    const emp = c.numEmployees ?? 0;
    const totalSq = spaces.reduce((s, x) => s + (x.squareFeetOccupied ?? 0), 0);
    const names = new Set<string>();
    for (const s of spaces) {
      const f = floors.get(s.propertyFloorId!)!;
      const share = totalSq > 0 ? (s.squareFeetOccupied ?? 0) / totalSq : 1 / spaces.length;
      f.people += emp * share;
      f.tenants += 1;
      names.add(f.name);
    }
    tenants.push({ name: c.name, employees: emp, floors: [...names], sqft: Math.round(totalSq) });
  }
  const list = [...floors.values()].map((f) => ({ ...f, people: Math.round(f.people) }));
  // Every level up to the stories count, even ones CoStar doesn't list (0 people known).
  const stories = property.numStoriesAboveGrade ?? 0;
  for (let l = 1; l <= stories; l++) if (!list.some((f) => f.level === l)) list.push({ floorId: null, name: `Level ${l}`, level: l, sqft: null, people: 0, tenants: 0 });
  list.sort((a, b) => (a.level ?? 999) - (b.level ?? 999));
  // One row per company (a tenant can hold several leases in the building).
  const merged = new Map<string, Tenant>();
  for (const t of tenants) {
    const m = merged.get(t.name);
    if (!m) merged.set(t.name, { ...t });
    else {
      m.floors = [...new Set([...m.floors, ...t.floors])];
      m.sqft += t.sqft;
    }
  }
  const tenantList = [...merged.values()].sort((a, b) => b.employees - a.employees);
  return { floors: list, tenants: tenantList, total: list.reduce((s, f) => s + f.people, 0) };
}

export interface CostarReader {
  available: boolean;
  dir: string | null;
  /** The searchable building list (Matterport capture list joined to property names). */
  index(): Promise<BuildingIndexEntry[]>;
  building(propertyId: number): Promise<BuildingSummary | null>;
}

export function costarReader(dir: string | undefined, cache: Cache): CostarReader {
  const ok = !!dir && existsSync(join(dir, "data", "commercial-property.jsonl"));
  const root = ok ? dir! : null;
  return {
    available: ok,
    dir: root,
    async index() {
      if (!root) return [];
      const key = `costar-index-v${CACHE_VERSION}`;
      const hit = cache.get<BuildingIndexEntry[]>(key);
      if (hit) return hit;
      const capture = readCaptureList(root);
      const out: BuildingIndexEntry[] = [];
      for await (const line of lines(join(root, "data", "commercial-property.jsonl"))) {
        const id = idAtStart(line);
        if (id === null || !capture.has(id)) continue;
        const p = JSON.parse(line) as RawProperty;
        const c = capture.get(id)!;
        const a = p.primaryAddress ?? {};
        out.push({
          propertyId: id,
          name: p.buildingName || a.buildingName || addressOf(p) || c.address,
          address: addressOf(p) || c.address,
          city: a.city ?? c.city,
          location: a.latitude != null && a.longitude != null ? { lat: a.latitude, lng: a.longitude } : null,
          stories: p.numStoriesAboveGrade ?? null,
          models: c.models,
        });
      }
      out.sort((a, b) => (b.stories ?? 0) - (a.stories ?? 0));
      cache.set(key, out);
      return out;
    },
    async building(propertyId) {
      if (!root) return null;
      const key = `costar-building-${propertyId}-v${CACHE_VERSION}`;
      const hit = cache.get<BuildingSummary>(key);
      if (hit) return hit;
      let property: RawProperty | null = null;
      const prefix = `{"id":${propertyId},`;
      for await (const line of lines(join(root, "data", "commercial-property.jsonl"))) {
        if (line.startsWith(prefix)) {
          property = JSON.parse(line) as RawProperty;
          break;
        }
      }
      if (!property) return null;
      const occupancies: RawOccupancy[] = [];
      const needle = `"propertyId":${propertyId},`;
      for await (const line of lines(join(root, "data", "location-occupancy.jsonl"))) if (line.includes(needle)) occupancies.push(JSON.parse(line) as RawOccupancy);
      const wanted = new Set(occupancies.filter(isCurrent).map((o) => o.tenantLocationId).filter((x): x is number => x != null));
      const companies = new Map<number, { name: string; numEmployees: number | null }>();
      if (wanted.size > 0) {
        for await (const line of lines(join(root, "data", "company-detail.jsonl"))) {
          const id = idAtStart(line);
          if (id === null || !wanted.has(id)) continue;
          const c = JSON.parse(line) as { name?: string; numEmployees?: number | null };
          companies.set(id, { name: c.name ?? `Tenant ${id}`, numEmployees: c.numEmployees ?? null });
          if (companies.size === wanted.size) break;
        }
      }
      const people = summarizePeople(property, occupancies, companies);
      const a = property.primaryAddress ?? {};
      const capture = readCaptureList(root).get(propertyId);
      const summary: BuildingSummary = {
        propertyId,
        name: property.buildingName || a.buildingName || addressOf(property),
        address: addressOf(property),
        city: a.city ?? "",
        state: a.state ?? "",
        location: { lat: a.latitude ?? 0, lng: a.longitude ?? 0 },
        stories: property.numStoriesAboveGrade ?? null,
        rentableSqft: property.rentableBuildingAreaSquareFeet ?? null,
        typicalFloorSqft: property.grossTypicalFloorSquareFeet ?? null,
        propertyType: property.propertyType != null ? propertyTypeNames(root)[String(property.propertyType)] ?? String(property.propertyType) : null,
        yearBuilt: property.constructionEvents?.find((e) => e.eventType === 2)?.year ?? null,
        floors: people.floors,
        topTenants: people.tenants.slice(0, 12),
        totalPeople: people.total,
        matterportModels: capture?.models ?? [],
        source: "CoStar extract (tenancies × company employee counts)",
      };
      cache.set(key, summary);
      return summary;
    },
  };
}

/**
 * Built-in facts for the demo building, used only when the CoStar extract isn't on this server (e.g. Render): public
 * name/address/height and Matterport model ids, no tenant or people data.
 */
export const DEMO_BUILDINGS: BuildingIndexEntry[] = [
  {
    propertyId: 233899,
    name: "Wells Fargo Plaza",
    address: "1000 Louisiana St",
    city: "Houston",
    location: { lat: 29.7584604, lng: -95.3682126 },
    stories: 71,
    models: ["3K5rnFt1P6B", "Gj2E4uqqdfU", "kDmRpp4ypA1", "qVqBanbJQze", "tzDLoMcCjuC", "Ry9V96reQ77", "jUnF84zghQk"],
  },
];

export function demoSummary(e: BuildingIndexEntry): BuildingSummary {
  const floors: FloorPeople[] = [];
  for (let l = 1; l <= (e.stories ?? 1); l++) floors.push({ floorId: null, name: String(l), level: l, sqft: null, people: 0, tenants: 0 });
  return {
    propertyId: e.propertyId,
    name: e.name,
    address: e.address,
    city: e.city,
    state: "",
    location: e.location ?? { lat: 0, lng: 0 },
    stories: e.stories,
    rentableSqft: null,
    typicalFloorSqft: null,
    propertyType: null,
    yearBuilt: null,
    floors,
    topTenants: [],
    totalPeople: 0,
    matterportModels: e.models,
    source: "built-in demo facts (CoStar extract not available on this server: no people data)",
  };
}

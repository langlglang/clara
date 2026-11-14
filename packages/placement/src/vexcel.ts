import type { Cache } from "./cache.js";
import { bounds, projector, ringStats } from "./geo.js";
import type { Aerial, Fetch, LatLng } from "./types.js";

/** Vexcel API v2 (header X-API-KEY): parcel + building footprint (property/extract) and the ortho image (ortho/extract). */

export const VEXCEL_API = "https://api.vexcelgroup.com/v2";
const LAYERS = "urban,urban-r,wide-area,urban-g";
const BUFFER_M = 15;

type Geometry = { type: "Polygon"; coordinates: [number, number][][] } | { type: "MultiPolygon"; coordinates: [number, number][][][] };
interface RawFeature {
  geometry: Geometry;
  properties: Record<string, unknown> & { structures?: Record<string, unknown>[] };
}

const outerRing = (g: Geometry): [number, number][] => (g.type === "Polygon" ? g.coordinates[0] : g.coordinates.sort((a, b) => ringStats(b[0]).areaM2 - ringStats(a[0]).areaM2)[0][0]);

const toWkt = (ring: [number, number][]) => `POLYGON ((${ring.map((p) => `${p[0]} ${p[1]}`).join(", ")}))`;

import { parseWktRings, pointInRing } from "./geo.js";

/** Pure: pick the newest capture's parcel and its largest structure (the building at the point). */
export function parseProperty(body: { features?: RawFeature[] }, at: LatLng): Omit<Aerial, "imageFile" | "imageBounds"> | null {
  const feats = (body.features ?? []).filter((f) => f.geometry);
  if (feats.length === 0) return null;
  const date = (f: RawFeature) => String(f.properties["metadata.ortho-date-estimate"] ?? "");
  const withStructures = feats.filter((f) => (f.properties.structures ?? []).length > 0);
  const pool = withStructures.length > 0 ? withStructures : feats;
  const f = [...pool].sort((a, b) => date(b).localeCompare(date(a)))[0];
  const parcel = outerRing(f.geometry);
  const p = projector(at);
  let best: { ring: [number, number][]; area: number; s: Record<string, unknown> } | null = null;
  for (const s of f.properties.structures ?? []) {
    const wkt = s["footprint.wkt"];
    if (typeof wkt !== "string") continue;
    for (const ring of parseWktRings(wkt)) {
      const area = ringStats(ring).areaM2;
      const contains = pointInRing(0, 0, ring.map((r) => p.toXY(r)));
      const score = area * (contains ? 2 : 1);
      if (!best || score > best.area) best = { ring, area: score, s };
    }
  }
  const footprint = best?.ring ?? parcel;
  const h = best?.s["roof-characteristics.maximum-roof-height"];
  const gsd = f.properties["metadata.gsd"];
  return {
    parcel,
    footprint,
    footprintAreaM2: Math.round(ringStats(footprint).areaM2),
    roofHeightM: typeof h === "number" ? h : null,
    captureDate: date(f) || null,
    gsdM: typeof gsd === "number" ? gsd : null,
  };
}

/** The ortho crop's bounds: the parcel's bounding box grown by the buffer. */
export function imageBoundsFor(parcel: [number, number][], bufferM = BUFFER_M): [number, number, number, number] {
  const [w, s, e, n] = bounds(parcel);
  const p = projector({ lat: s, lng: w });
  const d = p.toLatLng(bufferM, bufferM);
  const dLng = d.lng - w, dLat = d.lat - s;
  return [w - dLng, s - dLat, e + dLng, n + dLat];
}

export interface VexcelClient {
  configured: boolean;
  aerial(propertyId: number, at: LatLng, withImage?: boolean): Promise<Aerial>;
  image(file: string): Buffer | null;
}

export function vexcelClient(opts: { apiKey?: string; fetch?: Fetch; cache: Cache; timeoutMs?: number }): VexcelClient {
  const configured = !!opts.apiKey;
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  const H = () => ({ "X-API-KEY": opts.apiKey!, "Content-Type": "application/json" });
  return {
    configured,
    image: (file) => opts.cache.getBytes(file),
    async aerial(propertyId, at, withImage = true) {
      const key = `vx-aerial-${propertyId}`;
      let hit = opts.cache.get<Aerial>(key);
      if (!hit) {
        if (!configured) throw new Error("Vexcel key (VEXCEL_API_KEY) is not set on this server.");
        const q = new URLSearchParams({ wkt: `POINT(${at.lng} ${at.lat})`, srid: "4326", layer: LAYERS, latest: "true", include: "precomputed", "unit-system": "metric" });
        const res = await doFetch(`${VEXCEL_API}/property/extract?${q}`, { headers: { "X-API-KEY": opts.apiKey! }, signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000) });
        if (!res.ok) throw new Error(`Vexcel property/extract: ${res.status}`);
        const parsed = parseProperty((await res.json()) as { features?: RawFeature[] }, at);
        if (!parsed) throw new Error("Vexcel found no parcel at this point.");
        hit = { ...parsed, imageBounds: imageBoundsFor(parsed.parcel), imageFile: null };
        opts.cache.set(key, hit);
      }
      if (withImage && !hit.imageFile && configured) {
        const res = await doFetch(`${VEXCEL_API}/ortho/extract`, {
          method: "POST",
          headers: H(),
          body: JSON.stringify({ wkt: toWkt(hit.parcel), srid: 4326, layer: LAYERS, "buffer-meter": BUFFER_M, crop: "bounding_box", "image-format": "jpeg" }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
        if (res.ok) {
          const file = `vx-ortho-${propertyId}.jpg`;
          opts.cache.setBytes(file, Buffer.from(await res.arrayBuffer()));
          hit = { ...hit, imageFile: file };
          opts.cache.set(key, hit);
        }
      }
      return hit;
    },
  };
}

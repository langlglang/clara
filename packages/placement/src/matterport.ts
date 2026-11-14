import type { Cache } from "./cache.js";
import type { Fetch, ScanModel } from "./types.js";

/** Matterport Model API (GraphQL, HTTP basic auth key:token). Results cached per model. */

export const MP_GRAPH = "https://api.matterport.com/api/models/graph";

const MODEL_QUERY = `query Model($id: ID!) { model(id: $id) { id name geocoordinates { latitude longitude }
  floors { id label sequence panoLocations { id label position { x y z } } }
  rooms { id label floor { id } classifications { label } } } }`;

interface RawModel {
  id: string;
  name: string;
  geocoordinates?: { latitude?: number; longitude?: number } | null;
  floors?: { id: string; label?: string | null; sequence?: number | null; panoLocations?: { id: string; label?: string | null; position?: { x: number; y: number; z: number } | null }[] }[];
  rooms?: { id: string; label?: string | null; floor?: { id: string } | null; classifications?: { label?: string }[] }[];
}

export function parseModel(raw: RawModel): ScanModel {
  return {
    id: raw.id,
    name: raw.name,
    location: raw.geocoordinates?.latitude != null && raw.geocoordinates?.longitude != null ? { lat: raw.geocoordinates.latitude, lng: raw.geocoordinates.longitude } : null,
    floors: (raw.floors ?? []).map((f, i) => ({
      id: f.id,
      label: f.label ?? `Floor ${i + 1}`,
      sequence: f.sequence ?? i,
      panos: (f.panoLocations ?? []).filter((p) => p.position).map((p) => ({ id: p.id, label: p.label ?? "", x: p.position!.x, y: p.position!.y, z: p.position!.z })),
    })),
    rooms: (raw.rooms ?? []).map((r) => ({ id: r.id, label: r.label ?? "", floorId: r.floor?.id ?? null, classes: (r.classifications ?? []).map((c) => c.label ?? "").filter(Boolean) })),
  };
}

/** The building level a scan covers, from its name: "Level 53" → 53, "Suite 3700" → 37, "1175" → 11. */
export function levelFromScanName(name: string): number | null {
  const lvl = /\b(?:level|floor|fl)\s*(\d{1,3})\b/i.exec(name);
  if (lvl) return Number(lvl[1]);
  const suite = /\b(?:suite|ste)?\s*(\d{3,4})\b(?!.*\d{3,4})/i.exec(name.replace(/^\s*\d+\s+\w+/, ""));
  if (suite) return Math.floor(Number(suite[1]) / 100);
  return null;
}

export interface MatterportClient {
  configured: boolean;
  model(id: string): Promise<ScanModel>;
}

export function matterportClient(opts: { key?: string; token?: string; fetch?: Fetch; cache: Cache; timeoutMs?: number }): MatterportClient {
  const configured = !!(opts.key && opts.token);
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  return {
    configured,
    async model(id) {
      const key = `mp-model-${id}`;
      const hit = opts.cache.get<ScanModel>(key);
      if (hit) return hit;
      if (!configured) throw new Error("Matterport keys (MP_API_KEY, MP_API_TOKEN) are not set on this server.");
      const auth = Buffer.from(`${opts.key}:${opts.token}`).toString("base64");
      const res = await doFetch(MP_GRAPH, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ query: MODEL_QUERY, variables: { id } }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      const body = (await res.json()) as { data?: { model?: RawModel | null }; errors?: { message?: string }[] };
      if (!res.ok || !body.data?.model) throw new Error(`Matterport model ${id}: ${res.status} ${body.errors?.[0]?.message ?? "no model"}`);
      const model = parseModel(body.data.model);
      opts.cache.set(key, model);
      return model;
    },
  };
}

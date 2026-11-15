import { DEMO_RURAL, ROAD_FACTOR, planRural, type Settlement } from "@clara/placement";
import { fail, json, readJson } from "../../../../lib/http";
import { requireAdmin } from "../../../../lib/admin-auth";
import { RURAL_DATASETS, ruralDataset } from "../../../../lib/ruralDatasets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The places the planner knows (real UNHCR / Census data plus the demo county), with their settlements. */
export async function GET(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return json({ settlements: DEMO_RURAL, datasets: RURAL_DATASETS, roadFactor: ROAD_FACTOR });
}

/** Rural plan: K boxes at population-weighted centres of the given settlements (default: the demo county). */
export async function POST(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (!body.ok) return body.response;
  const b = (body.body ?? {}) as { boxes?: unknown; reachKm?: unknown; settlements?: unknown; dataset?: unknown };
  if (typeof b.boxes !== "number" || !Number.isInteger(b.boxes) || b.boxes < 1 || b.boxes > 100) return fail(400, "bad_request", "boxes must be a whole number from 1 to 100.");
  const named = b.dataset != null ? ruralDataset(b.dataset) : null;
  if (b.dataset != null && !named) return fail(400, "bad_request", "Unknown dataset.");
  const reachKm = typeof b.reachKm === "number" && b.reachKm > 0 && b.reachKm <= 200 ? b.reachKm : named?.reachKm ?? 10;
  let list: Settlement[] = named?.settlements ?? DEMO_RURAL;
  if (b.settlements != null) {
    if (!Array.isArray(b.settlements) || b.settlements.length > 2000) return fail(400, "bad_request", "settlements must be a list (at most 2000).");
    list = [];
    for (const s of b.settlements as Settlement[]) {
      const ok = s && typeof s.name === "string" && s.name.length <= 80 && typeof s.people === "number" && s.people >= 0 && Number.isFinite(s.at?.lat) && Number.isFinite(s.at?.lng) && Math.abs(s.at.lat) <= 90 && Math.abs(s.at.lng) <= 180;
      if (!ok) return fail(400, "bad_request", "Each settlement needs name, people and at {lat, lng}.");
      list.push({ name: s.name, people: Math.round(s.people), at: { lat: s.at.lat, lng: s.at.lng } });
    }
  }
  return json(planRural(list, b.boxes, { reachKm }));
}

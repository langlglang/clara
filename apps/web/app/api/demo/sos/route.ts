import { fail, json } from "../../../../lib/http";
import { demoSosBatch, type Need } from "../../../../lib/demo";
import { runtime } from "../../../../lib/server";

export const dynamic = "force-dynamic";

const NEEDS: readonly Need[] = ["bleeding", "breathing", "general"];

/**
 * Demo only: `POST /api/demo/sos?box=box-clinic&need=bleeding` injects box.opened + sos.opened for a box, so the
 * network flow can be shown without hardware. If the box already has an open incident, the SOS joins it.
 */
export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const boxId = url.searchParams.get("box") ?? "box-clinic";
  const need = (url.searchParams.get("need") ?? "bleeding") as Need;
  if (!NEEDS.includes(need)) return fail(400, "bad_request", `need must be one of ${NEEDS.join(", ")}.`);
  const rt = runtime();
  if (!rt.network.store.getBox(boxId)) return fail(404, "not_found", `Unknown box "${boxId}".`);
  const result = rt.network.ingest(demoSosBatch(boxId, need, rt.network.clock()));
  if (!result.ok) return fail(400, "bad_request", result.error);
  const open = rt.network.openIncidentForBox(boxId);
  return json({ demo: true, opened: result.opened.map((i) => i.incident_id), incident: open?.incident ?? null }, 201);
}

import { fail, json } from "../../../../lib/http";
import { demoCloseBatch } from "../../../../lib/demo";
import { ensureRuntime } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/** Demo only: `POST /api/demo/close?box=box-clinic` closes the lid, which ends the box's open incident. */
export async function POST(req: Request): Promise<Response> {
  const boxId = new URL(req.url).searchParams.get("box") ?? "box-clinic";
  const rt = await ensureRuntime();
  const entry = rt.network.store.getBox(boxId);
  if (!entry) return fail(404, "not_found", `Unknown box "${boxId}".`);
  const result = rt.network.ingest(demoCloseBatch(boxId, entry.open_session_id, rt.network.clock()));
  if (!result.ok) return fail(400, "bad_request", result.error);
  return json({ demo: true, closed: result.closed.map((i) => i.incident_id) });
}

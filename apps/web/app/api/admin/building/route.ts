import { pickupCandidates } from "@clara/placement";
import { fail, json } from "../../../../lib/http";
import { floorGraphs, loadBuilding } from "../../../../lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/** One building: CoStar facts and people per floor, Matterport floor graphs, Vexcel footprint and pickup candidates. */
export async function GET(req: Request): Promise<Response> {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail(400, "bad_request", "id must be a CoStar PropertyId.");
  try {
    const loaded = await loadBuilding(id);
    if (!loaded) return fail(404, "not_found", "No such building.");
    const { input, scans, warnings } = loaded;
    const aerial = input.aerial ? { ...input.aerial, hasImage: !!input.aerial.imageFile, imageFile: undefined } : null;
    return json({ building: input.building, scans, warnings, aerial, pickups: pickupCandidates(input.aerial), graphs: floorGraphs(input.graphs) });
  } catch (e) {
    return fail(500, "server_error", (e as Error).message.slice(0, 200));
  }
}

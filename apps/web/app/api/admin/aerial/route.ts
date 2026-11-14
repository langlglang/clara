import { fail } from "../../../../lib/http";
import { admin, loadBuilding } from "../../../../lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The Vexcel ortho image of a building's parcel (JPEG, cached on disk). */
export async function GET(req: Request): Promise<Response> {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail(400, "bad_request", "id must be a CoStar PropertyId.");
  const loaded = await loadBuilding(id).catch(() => null);
  const file = loaded?.input.aerial?.imageFile;
  const bytes = file ? admin().placement.vexcel.image(file) : null;
  if (!bytes) return fail(404, "not_found", "No aerial image for this building.");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
}

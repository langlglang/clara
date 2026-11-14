import { fail } from "../../../../lib/http";
import { AdminBusyError, admin, loadBuilding } from "../../../../lib/admin";
import { requireAdmin } from "../../../../lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The Vexcel ortho image of a building's parcel (JPEG, cached on disk). */
export async function GET(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail(400, "bad_request", "id must be a CoStar PropertyId.");
  let loaded: Awaited<ReturnType<typeof loadBuilding>>;
  try { loaded = await loadBuilding(id); }
  catch (error) {
    if (error instanceof AdminBusyError) return fail(429, "conflict", error.message);
    return fail(404, "not_found", "No aerial image for this building.");
  }
  const file = loaded?.input.aerial?.imageFile;
  const bytes = file ? admin().placement.vexcel.image(file) : null;
  if (!bytes) return fail(404, "not_found", "No aerial image for this building.");
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
}

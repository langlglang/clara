import { fail, json } from "../../../../lib/http";
import { admin } from "../../../../lib/admin";
import { requireAdmin } from "../../../../lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Search CoStar's Matterport-captured buildings (?q=). Without the extract, only the built-in demo building. */
export async function GET(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 80);
  try {
    const p = admin().placement;
    return json({ costar: p.costar.available, buildings: await p.searchBuildings(q) });
  } catch (e) {
    return fail(500, "server_error", (e as Error).message.slice(0, 200));
  }
}

import { json } from "../../../../lib/http";
import { ensureRuntime } from "../../../../lib/server";
import { adminBoxes } from "../../../../lib/admin";

export const dynamic = "force-dynamic";

/** Boxes in an area (?area=houston|la|camp) with health: status, battery, last seen, supplies, open incidents. */
export async function GET(req: Request): Promise<Response> {
  const area = new URL(req.url).searchParams.get("area") ?? "houston";
  return json(adminBoxes(await ensureRuntime(), area));
}

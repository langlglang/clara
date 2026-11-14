import { fail, json } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** Pass over the suggested driver (withdrawing open offers) so the next backup is suggested. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const r = runtime().rides.reassign(id);
  if (r.ok) return json({ ride: r.ride });
  return r.error === "not_found" ? fail(404, "not_found", "No ride with that id.") : fail(409, "conflict", "This ride is already settled or its emergency closed.");
}

import { fail, json } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The dispatcher calls the ride off; open offers are withdrawn. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const ride = (await ensureRuntime()).rides.cancel(id);
  return ride ? json({ ride }) : fail(404, "not_found", "No ride with that id.");
}

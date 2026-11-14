import { fail, json, readJson } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The dispatcher approves an offer to a driver: `{ driver_id? }` (default: the suggested driver). Offers expire after 60 s. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const driver = (read.body as { driver_id?: unknown } | undefined)?.driver_id;
  if (driver !== undefined && typeof driver !== "string") return fail(400, "bad_request", "driver_id must be a string.");
  const r = runtime().rides.approve(id, driver as string | undefined);
  if (r.ok) return json({ ride: r.ride });
  if (r.error === "not_found") return fail(404, "not_found", "No ride with that id.");
  if (r.error === "closed") return fail(409, "conflict", "This ride is already settled or its emergency closed.");
  return fail(409, "conflict", "No suitable free driver to offer it to.");
}

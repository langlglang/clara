import { fail, json, readJson } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * A driver's answer to a ride offer: `{ driver_id, action: "accept" | "decline" }`. The first accept wins (200
 * `accepted`); anyone later gets 409 `taken`; an offer past its 60 s gets 409 `expired`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const body = (read.body ?? {}) as { driver_id?: unknown; action?: unknown };
  if (typeof body.driver_id !== "string" || (body.action !== "accept" && body.action !== "decline")) return fail(400, "bad_request", 'Expected { driver_id, action: "accept" | "decline" }.');
  const r = (await ensureRuntime()).rides.answer(id, body.driver_id, body.action);
  switch (r.outcome) {
    case "accepted":
    case "declined":
      return json({ outcome: r.outcome, ride: r.ride });
    case "not_found":
      return fail(404, "not_found", "No ride with that id.");
    case "not_offered":
      return fail(403, "forbidden", "This ride wasn't offered to you.");
    case "taken":
      return fail(409, "conflict", "Another driver already took this ride.", { outcome: "taken", ride: r.ride });
    case "expired":
      return fail(409, "conflict", "This offer expired.", { outcome: "expired", ride: r.ride });
    case "closed":
      return fail(409, "conflict", "This emergency has already closed.", { outcome: "closed", ride: r.ride });
  }
}

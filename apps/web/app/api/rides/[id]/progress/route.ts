import { fail, json, readJson } from "../../../../../lib/http";
import { TRIP_STEPS, type TripStep } from "../../../../../lib/rides";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * The winning driver's progress: `{ driver_id, step: "to_pickup" | "patient_in_car" | "at_hospital" }`. Forward only;
 * a repeat is harmless. Only the driver who won the ride may report it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const body = (read.body ?? {}) as { driver_id?: unknown; step?: unknown };
  if (typeof body.driver_id !== "string" || !TRIP_STEPS.includes(body.step as TripStep)) return fail(400, "bad_request", `Expected { driver_id, step: ${TRIP_STEPS.join(" | ")} }.`);
  const r = runtime().rides.progress(id, body.driver_id, body.step as TripStep);
  switch (r.outcome) {
    case "updated":
      return json({ outcome: r.outcome, ride: r.ride });
    case "not_found":
      return fail(404, "not_found", "No ride with that id.");
    case "not_winner":
      return fail(403, "forbidden", "Only the driver who accepted this ride can update it.");
    case "closed":
      return fail(409, "conflict", "This ride was cancelled.", { ride: r.ride });
    case "invalid":
      return fail(409, "conflict", "That step is already behind you.", { ride: r.ride });
  }
}

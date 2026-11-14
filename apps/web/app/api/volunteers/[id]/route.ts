import { fail, json, readJson } from "../../../../lib/http";
import { applyProfileRules, parseProfilePatch } from "../../../../lib/profile";
import { ensureRuntime } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/** One volunteer's profile, with the web app's vehicle kind and how many devices get push alerts. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  const volunteer = rt.network.store.getVolunteer(id);
  if (!volunteer) return fail(404, "not_found", "No volunteer with that id.");
  return json({ volunteer, vehicle: rt.vehicles.get(id) ?? (volunteer.vehicle_seats > 0 ? "car" : "none"), push_devices: rt.push.devices(id) });
}

/**
 * Profile edits from the companion app: any of name, skills, languages, vehicle (+ vehicle_seats, carries_lying_down,
 * carries_wheelchair), location, available, channel, phone (E.164), alert_radius_km (0.5–10), call_consent,
 * quiet_hours `{ start, end, tz }`, usual_availability. null clears an optional field. Unknown fields get 400.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const rt = await ensureRuntime();
  const current = rt.network.store.getVolunteer(id);
  if (!current) return fail(404, "not_found", "No volunteer with that id. The demo server may have restarted; sign up again.");
  const parsed = parseProfilePatch(read.body);
  if (!parsed.ok) return fail(400, "bad_request", parsed.message, parsed.issues ? { issues: parsed.issues } : {});
  const currentVehicle = rt.vehicles.get(id) ?? (current.vehicle_seats > 0 ? "car" : "none");
  const ruled = applyProfileRules(current, currentVehicle, parsed);
  if (!ruled.ok) return fail(400, "bad_request", ruled.message);
  let volunteer;
  try {
    volunteer = rt.network.updateVolunteer(id, ruled.patch);
  } catch {
    return fail(400, "bad_request", "Some profile fields aren't valid.");
  }
  if (!volunteer) return fail(404, "not_found", "No volunteer with that id.");
  rt.vehicles.set(id, ruled.vehicle);
  rt.emit({ kind: "profile", volunteer_id: id });
  return json({ volunteer, vehicle: ruled.vehicle, push_devices: rt.push.devices(id) });
}

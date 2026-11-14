import { VolunteerSchema } from "@clara/contracts";
import { fail, issues, json, readJson } from "../../../lib/http";
import { VEHICLE_KINDS, type VehicleKind } from "../../../lib/rides";
import { runtime } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** What the sign-up form sends; the server picks the id and starts the volunteer as available. */
const SignUpSchema = VolunteerSchema.omit({ volunteer_id: true, available: true });

/**
 * Companion-app sign-up. Body: the contract's Volunteer fields (minus id and availability) plus an optional
 * `vehicle` ("car" | "van" | "motorbike" | "none"), kept by the web app for ride matching. Answers 201 `{ volunteer }`.
 */
export async function POST(req: Request): Promise<Response> {
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const { vehicle, ...rest } = (read.body && typeof read.body === "object" ? read.body : {}) as { vehicle?: unknown } & Record<string, unknown>;
  if (vehicle !== undefined && !VEHICLE_KINDS.includes(vehicle as VehicleKind)) return fail(400, "bad_request", `vehicle must be one of ${VEHICLE_KINDS.join(", ")}.`);
  const parsed = SignUpSchema.safeParse(rest);
  if (!parsed.success) return fail(400, "bad_request", "The sign-up isn't complete.", { issues: issues(parsed.error) });
  const rt = runtime();
  const volunteer = rt.network.registerVolunteer({ ...parsed.data, volunteer_id: `vol-${crypto.randomUUID()}`, available: true });
  const kind = (vehicle as VehicleKind | undefined) ?? (volunteer.vehicle_seats > 0 ? "car" : "none");
  rt.vehicles.set(volunteer.volunteer_id, volunteer.vehicle_seats > 0 ? kind : "none");
  rt.emit({ kind: "profile", volunteer_id: volunteer.volunteer_id });
  return json({ volunteer }, 201);
}

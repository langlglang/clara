import { VolunteerSchema } from "@clara/contracts";
import { E164 } from "../../../lib/alertText";
import { fail, issues, json, readJson } from "../../../lib/http";
import { applyProfileRules } from "../../../lib/profile";
import { VEHICLE_KINDS, type VehicleKind } from "../../../lib/rides";
import { ensureRuntime } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** What the sign-up form sends; the server picks the id. Availability defaults to on. */
const SignUpSchema = VolunteerSchema.omit({ volunteer_id: true, available: true }).extend({ available: VolunteerSchema.shape.available.optional() });

/**
 * Companion-app sign-up. Body: the contract's Volunteer fields (minus the id; `available` optional, default true)
 * plus an optional `vehicle` ("car" | "van" | "motorbike" | "none"), kept by the web app for ride matching. A vehicle
 * adds the `driver` skill (a driver-only volunteer gets ride offers, never first-aid alerts). Phone numbers are E.164;
 * call consent needs one. Answers 201 `{ volunteer }`.
 */
export async function POST(req: Request): Promise<Response> {
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const { vehicle, ...rest } = (read.body && typeof read.body === "object" ? read.body : {}) as { vehicle?: unknown } & Record<string, unknown>;
  if (vehicle !== undefined && !VEHICLE_KINDS.includes(vehicle as VehicleKind)) return fail(400, "bad_request", `vehicle must be one of ${VEHICLE_KINDS.join(", ")}.`);
  if (typeof rest.phone === "string") rest.phone = rest.phone.replace(/[\s()-]/g, "") || undefined;
  // A driver with no first-aid skills signs up as "driver" (the contract needs one skill); no vehicle and no skill is refused.
  if (vehicle !== undefined && vehicle !== "none" && Array.isArray(rest.skills) && !rest.skills.includes("driver")) rest.skills = [...rest.skills, "driver"];
  const parsed = SignUpSchema.safeParse(rest);
  if (!parsed.success) return fail(400, "bad_request", "The sign-up isn't complete.", { issues: issues(parsed.error) });
  if (parsed.data.phone !== undefined && !E164.test(parsed.data.phone)) return fail(400, "bad_request", "Phone numbers use the international format, e.g. +15551234567.");
  const draft = { ...parsed.data, volunteer_id: `vol-${crypto.randomUUID()}`, available: parsed.data.available ?? true };
  const kind: VehicleKind = (vehicle as VehicleKind | undefined) ?? (draft.vehicle_seats > 0 ? "car" : "none");
  const ruled = applyProfileRules(draft, kind, { patch: draft.call_consent === undefined ? {} : { call_consent: draft.call_consent }, vehicle: kind });
  if (!ruled.ok) return fail(400, "bad_request", ruled.message);
  const merged: Record<string, unknown> = { ...draft, ...ruled.patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const rt = await ensureRuntime();
  const volunteer = rt.network.registerVolunteer(merged as typeof draft);
  rt.vehicles.set(volunteer.volunteer_id, ruled.vehicle);
  rt.emit({ kind: "profile", volunteer_id: volunteer.volunteer_id });
  return json({ volunteer }, 201);
}

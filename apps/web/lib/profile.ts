import { VolunteerSchema, type Volunteer } from "@clara/contracts";
import { E164 } from "./alertText";
import { VEHICLE_KINDS, type VehicleKind } from "./rides";

/**
 * Profile edits from the companion app (PATCH /api/volunteers/[id]) and the rules sign-up shares with it: phone
 * numbers are E.164, call consent needs a number, a vehicle makes you a driver (the `driver` skill, which alone
 * never matches a first-aid alert) and no vehicle means no seats.
 */

const EDITABLE = VolunteerSchema.pick({
  name: true,
  skills: true,
  languages: true,
  vehicle_seats: true,
  location: true,
  available: true,
  channel: true,
  phone: true,
  alert_radius_km: true,
  call_consent: true,
  quiet_hours: true,
  carries_lying_down: true,
  carries_wheelchair: true,
  usual_availability: true,
}).partial();

/** Fields that may be cleared by sending null (or "" for text). */
const CLEARABLE = ["phone", "quiet_hours", "usual_availability", "alert_radius_km", "carries_lying_down", "carries_wheelchair"] as const;

export type ProfilePatch = Partial<Omit<Volunteer, "volunteer_id">>;

export type ParsedPatch = { ok: true; patch: ProfilePatch; vehicle: VehicleKind | undefined } | { ok: false; message: string; issues?: string[] };

const issueList = (error: { issues: { path: PropertyKey[]; message: string }[] }) => error.issues.slice(0, 10).map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`);

/** Checks a PATCH body. Unknown fields are refused; null (or "") clears an optional field. */
export function parseProfilePatch(body: unknown): ParsedPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Expected a JSON object of profile fields." };
  const { vehicle, ...raw } = body as Record<string, unknown> & { vehicle?: unknown };
  if (vehicle !== undefined && !VEHICLE_KINDS.includes(vehicle as VehicleKind)) return { ok: false, message: `vehicle must be one of ${VEHICLE_KINDS.join(", ")}.` };
  const cleared: string[] = [];
  for (const key of CLEARABLE) {
    if (raw[key] === null || raw[key] === "") {
      cleared.push(key);
      delete raw[key];
    }
  }
  if (typeof raw.phone === "string") raw.phone = raw.phone.replace(/[\s()-]/g, "");
  // No first-aid skills is fine for a driver; applyProfileRules decides whether the result can stand.
  const noSkills = Array.isArray(raw.skills) && raw.skills.length === 0;
  if (noSkills) delete raw.skills;
  const parsed = EDITABLE.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Some profile fields aren't valid.", issues: issueList(parsed.error) };
  if (parsed.data.phone !== undefined && !E164.test(parsed.data.phone)) return { ok: false, message: "Phone numbers use the international format, e.g. +15551234567." };
  const patch: ProfilePatch = { ...parsed.data, ...(noSkills ? { skills: [] } : {}) };
  for (const key of cleared) (patch as Record<string, unknown>)[key] = undefined;
  return { ok: true, patch, vehicle: vehicle as VehicleKind | undefined };
}

/**
 * The volunteer after a patch, with the cross-field rules applied: vehicle ↔ driver skill and seats, call consent
 * only with a phone number. Returns an error message instead when the result can't stand.
 */
export function applyProfileRules(current: Volunteer, currentVehicle: VehicleKind, p: { patch: ProfilePatch; vehicle: VehicleKind | undefined }): { ok: true; patch: ProfilePatch; vehicle: VehicleKind } | { ok: false; message: string } {
  const patch: ProfilePatch = { ...p.patch };
  const vehicle = p.vehicle ?? currentVehicle;
  const skills: Volunteer["skills"] = (patch.skills ?? current.skills).filter((s) => s !== "driver");
  const hasCar = vehicle !== "none";
  if (hasCar) skills.push("driver");
  if (skills.length === 0) return { ok: false, message: "Pick at least one way to help: a first-aid skill, or a vehicle to drive." };
  patch.skills = skills;
  const seats = patch.vehicle_seats ?? current.vehicle_seats;
  if (!hasCar) {
    patch.vehicle_seats = 0;
    patch.carries_lying_down = undefined;
    patch.carries_wheelchair = undefined;
  } else if (seats < 1) {
    return { ok: false, message: "A vehicle needs at least one free seat." };
  }
  const phone = "phone" in patch ? patch.phone : current.phone;
  if ("call_consent" in patch) {
    if (patch.call_consent && !phone) return { ok: false, message: "Add a phone number before agreeing to calls." };
  } else if (!phone && current.call_consent) {
    // Removing the number withdraws consent to calls.
    patch.call_consent = false;
  }
  return { ok: true, patch, vehicle };
}

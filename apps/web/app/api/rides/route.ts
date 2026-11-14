import { fail, json, readJson } from "../../../lib/http";
import { runtime } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** All rides (console). */
export async function GET(): Promise<Response> {
  return json({ rides: runtime().rides.list() });
}

/** The dispatcher asks for a ride to hospital for an open incident: `{ incident_id, note? }`. One per incident. */
export async function POST(req: Request): Promise<Response> {
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const body = (read.body ?? {}) as { incident_id?: unknown; note?: unknown; seats_needed?: unknown };
  if (typeof body.incident_id !== "string") return fail(400, "bad_request", "Expected { incident_id, note?, seats_needed? }.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 120)) return fail(400, "bad_request", "note is up to 120 characters.");
  if (body.seats_needed !== undefined && (typeof body.seats_needed !== "number" || !Number.isInteger(body.seats_needed) || body.seats_needed < 1 || body.seats_needed > 8))
    return fail(400, "bad_request", "seats_needed is a whole number from 1 to 8.");
  const ride = runtime().rides.request(body.incident_id, (body.note as string | undefined) ?? null, (body.seats_needed as number | undefined) ?? 1);
  return ride ? json({ ride }, 201) : fail(404, "not_found", "No open incident with that id.");
}

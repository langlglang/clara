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
  const body = (read.body ?? {}) as { incident_id?: unknown; note?: unknown };
  if (typeof body.incident_id !== "string") return fail(400, "bad_request", "Expected { incident_id, note? }.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 120)) return fail(400, "bad_request", "note is up to 120 characters.");
  const ride = runtime().rides.request(body.incident_id, (body.note as string | undefined) ?? null);
  return ride ? json({ ride }, 201) : fail(404, "not_found", "No open incident with that id.");
}

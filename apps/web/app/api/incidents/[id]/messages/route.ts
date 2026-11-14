import { fail, json, readJson } from "../../../../../lib/http";
import { ensureRuntime, type BoxMessage } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const MAX_TEXT = 200;

/**
 * A volunteer who said they're coming (or arrived) sends a short message; the box reads it aloud
 * (`responder.message` on its stream). Body: `{ volunteer_id, text }`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const body = (read.body ?? {}) as { volunteer_id?: unknown; text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (typeof body.volunteer_id !== "string" || !text || text.length > MAX_TEXT) return fail(400, "bad_request", `Expected { volunteer_id, text } with 1 to ${MAX_TEXT} characters.`);
  const rt = await ensureRuntime();
  const view = rt.network.incident(id);
  if (!view) return fail(404, "not_found", "No incident with that id.");
  if (view.incident.closed) return fail(409, "conflict", "This emergency has already closed.");
  const alert = view.incident.alerts.find((a) => a.volunteer_id === body.volunteer_id);
  if (!alert || (alert.state !== "coming" && alert.state !== "arrived")) return fail(403, "forbidden", "Only a volunteer who said they're coming can message the box.");
  const message: BoxMessage = { incident_id: id, box_id: view.incident.box_id, from_id: alert.volunteer_id, from: alert.volunteer_name, text, at: rt.network.clock().toISOString() };
  const list = rt.messages.get(id) ?? [];
  list.push(message);
  rt.messages.set(id, list.slice(-50));
  rt.emit({ kind: "push", box_id: message.box_id, push: { type: "responder.message", incident_id: id, from: message.from, text } });
  rt.emit({ kind: "message", message });
  return json({ message }, 201);
}

import { AlertResponseSchema, VolunteerSchema } from "@clara/contracts";
import { fail, issues, json, readJson } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const RespondSchema = AlertResponseSchema.extend({ volunteer_id: VolunteerSchema.shape.volunteer_id });

/**
 * A volunteer's answer: `{ volunteer_id, action: "shown" | "coming" | "declined" | "arrived" }`. Only the
 * volunteer the alert went to may answer; a repeated tap is harmless; a late answer gets 409 with the incident.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const parsed = RespondSchema.safeParse(read.body);
  if (!parsed.success) return fail(400, "bad_request", "Expected { volunteer_id, action }.", { issues: issues(parsed.error) });
  const rt = await ensureRuntime();
  const result = rt.network.respond(id, parsed.data.volunteer_id, parsed.data.action);
  switch (result.outcome) {
    case "answered":
    case "unchanged":
      return json({ outcome: result.outcome, alert: result.alert, coming_line: rt.network.comingLine(result.incident.box_id) });
    case "not_found":
      return fail(404, "not_found", "No alert with that id.");
    case "not_yours":
      return fail(403, "forbidden", "This alert went to someone else.");
    case "closed":
      return fail(409, "conflict", "This emergency has already closed.", { alert: result.alert });
    case "invalid":
      return fail(409, "conflict", `Can't go from "${result.alert.state}" to "${parsed.data.action}".`, { alert: result.alert });
  }
}

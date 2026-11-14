import { fail, json } from "../../../../lib/http";
import { runtime } from "../../../../lib/server";
import { incidentDetail } from "../../../../lib/views";

export const dynamic = "force-dynamic";

/** One incident for the dashboard: alerts, escalation, the scene report (timeline, triage) and who's left to alert. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const detail = incidentDetail(runtime(), id);
  return detail ? json(detail) : fail(404, "not_found", "No incident with that id.");
}

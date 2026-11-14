import { fail, json } from "../../../../../lib/http";
import { requireAdmin } from "../../../../../lib/admin-auth";
import { briefingLines, latestIncidentId } from "../../../../../lib/demo911";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * The simulated 911 call's script for one incident: Clara's briefing to a dispatcher, built only from the box's
 * events. `"latest"` picks the most recent incident. The call page speaks it (audio from ./audio, or the browser).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  const incidentId = id === "latest" ? latestIncidentId(rt.network.store.listIncidents()) : id;
  const b = incidentId ? briefingLines(rt.network, incidentId) : null;
  if (!incidentId || !b) return fail(404, "not_found", "No incident with that id.");
  return json({ incident_id: incidentId, ...b, voice: Boolean(process.env.CARTESIA_API_KEY?.trim()) });
}

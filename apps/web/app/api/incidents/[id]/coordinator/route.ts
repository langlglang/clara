import { fail, json } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";
import { coordinatorView } from "../../../../../lib/views";

export const dynamic = "force-dynamic";

/**
 * The response coordinator's log for one incident: mode ("deep agent" / "rules" / "off"), plan (todos with status),
 * tool calls with arguments, results and reasons, dispatch notes, needs-a-human flags, subagent work, the agent's
 * working notes and run timing. `log` is null until the coordinator first looks at the incident.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.network.incident(id)) return fail(404, "not_found", "No incident with that id.");
  return json(coordinatorView(rt, id));
}

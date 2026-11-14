import { fail, sseResponse } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * The box's live stream: Server-Sent Events, one BoxPush per message (default event name), keep-alive comments
 * every 15 s. On connect it replays the alert states of the box's open incident, so a box that reconnects
 * catches up (its report link first, then alert states). Pushes come from the network (alerts, nearby boxes) and from the web app (volunteer messages,
 * ride accepts).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.network.store.getBox(id)) return fail(404, "not_found", `Unknown box "${id}".`);
  return sseResponse(req, (out) => {
    const open = rt.network.openIncidentForBox(id);
    const opened = rt.network.incidentOpenedFor(id);
    if (opened) out.send(opened);
    if (open) for (const alert of open.incident.alerts) out.send({ type: "alert.update", incident_id: open.incident.incident_id, alert });
    const emergencyQuestion = rt.emergency.pendingForBox(id);
    if (emergencyQuestion) out.send(emergencyQuestion);
    const offNetwork = rt.network.subscribe((change) => {
      if (change.kind === "push" && change.box_id === id) out.send(change.push);
    });
    const offApp = rt.subscribe((change) => {
      if (change.kind === "push" && change.box_id === id) out.send(change.push);
    });
    return () => {
      offNetwork();
      offApp();
    };
  });
}

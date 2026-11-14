import { EventBatchSchema } from "@clara/contracts";
import { fail, issues, json, readJson } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The box posts its event batch here (oldest first). Re-sending an event_id is harmless. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = runtime();
  if (!rt.network.store.getBox(id)) return fail(404, "not_found", `Unknown box "${id}".`);
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const parsed = EventBatchSchema.safeParse(read.body);
  if (!parsed.success) return fail(400, "bad_request", "The batch doesn't match the events contract.", { issues: issues(parsed.error) });
  const foreign = parsed.data.events.filter((e) => e.box_id !== id);
  if (foreign.length > 0) return fail(400, "bad_request", `Every event in the batch must be for box "${id}".`);
  const result = rt.network.ingest(parsed.data);
  if (!result.ok) return fail(400, "bad_request", result.error);
  return json({
    accepted: result.accepted.length,
    duplicates: result.duplicates.length,
    opened: result.opened.map((i) => i.incident_id),
    closed: result.closed.map((i) => i.incident_id),
    coming_line: rt.network.comingLine(id),
  });
}

import { TurnRequestSchema } from "@clara/contracts";
import { fail, issues, json, readJson } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** One voice turn from the box (TurnRequest → TurnResponse). The agent keeps its own budget (CLARA_TURN_BUDGET_MS). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const receivedAt = Date.now();
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.network.store.getBox(id)) return fail(404, "not_found", `Unknown box "${id}".`);
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const parsed = TurnRequestSchema.safeParse(read.body);
  if (!parsed.success) return fail(400, "bad_request", "The turn doesn't match the voice-turn contract.", { issues: issues(parsed.error) });
  try {
    return json(await rt.agent.handleTurn(parsed.data, receivedAt));
  } catch (error) {
    console.error("[turn] failed:", error);
    return fail(500, "server_error", "The turn failed on the server.");
  }
}

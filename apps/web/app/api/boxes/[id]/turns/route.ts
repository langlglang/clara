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
  const pending = rt.emergency.pendingForBox(id);
  const offered = parsed.data.state.pending_emergency_question;
  const validPending = pending?.type === "emergency.question" && offered?.task_id === pending.task_id && offered.question_id === pending.question_id && parsed.data.session_id === pending.session_id;
  // The box's state is a hint, not authority. Remove an expired or forged caller question before the model sees it.
  const turn = { ...parsed.data, state: { ...parsed.data.state,
    pending_emergency_question: validPending ? offered : undefined,
    camera_available: rt.cameraEnabled && parsed.data.state.camera_available === true,
    pending_camera_consent: rt.cameraEnabled ? parsed.data.state.pending_camera_consent : undefined,
    core_context: undefined,
  } };
  try {
    const cached = rt.core.cached(id, turn);
    if (cached) return json(cached);
    const prepared = rt.core.prepare(id, turn);
    const response = await rt.agent.handleTurn(prepared, receivedAt, req.signal);
    rt.core.finish(id, prepared, response, req.signal.aborted);
    return json(response);
  } catch (error) {
    console.error("[turn] failed:", error);
    return fail(500, "server_error", "The turn failed on the server.");
  }
}

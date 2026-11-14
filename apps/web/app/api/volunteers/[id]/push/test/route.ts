import { fail, json } from "../../../../../../lib/http";
import { TEST_PAYLOAD } from "../../../../../../lib/notify";
import { ensureRuntime } from "../../../../../../lib/server";

export const dynamic = "force-dynamic";

const MIN_GAP_MS = 10_000;
const KEY = Symbol.for("clara.web.pushTestAt");
const lastTest = ((globalThis as { [KEY]?: Map<string, number> })[KEY] ??= new Map<string, number>());

/** "Send me a test alert": a plainly-labeled test notification to each of the volunteer's devices (one per 10 s). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.network.store.getVolunteer(id)) return fail(404, "not_found", "No volunteer with that id.");
  if (rt.push.devices(id) === 0) return fail(409, "conflict", "This phone isn't subscribed to alerts yet. Turn on alerts first.");
  const now = Date.now();
  if (now - (lastTest.get(id) ?? 0) < MIN_GAP_MS) return fail(409, "conflict", "A test was just sent. Wait a few seconds.");
  lastTest.set(id, now);
  const result = await rt.push.send(id, TEST_PAYLOAD(id));
  return json(result);
}

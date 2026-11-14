import { fail, json, readJson } from "../../../../../lib/http";
import { parseSubscription } from "../../../../../lib/push";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** Saves this device's PushSubscription for the volunteer: `{ subscription }` (the browser's subscription JSON). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const rt = await ensureRuntime();
  if (!rt.network.store.getVolunteer(id)) return fail(404, "not_found", "No volunteer with that id.");
  const sub = parseSubscription((read.body as { subscription?: unknown } | undefined)?.subscription);
  if (!sub) return fail(400, "bad_request", "Expected { subscription: { endpoint, keys: { p256dh, auth } } }.");
  return json({ devices: rt.push.save(id, sub) }, 201);
}

/** Removes one device (`{ endpoint }`) or, with no body, every device of the volunteer. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const endpoint = (read.body as { endpoint?: unknown } | undefined)?.endpoint;
  if (endpoint !== undefined && typeof endpoint !== "string") return fail(400, "bad_request", "Expected { endpoint } or no body.");
  return json({ devices: (await ensureRuntime()).push.remove(id, endpoint) });
}

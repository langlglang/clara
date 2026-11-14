import { fail, json, readJson } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The Home screen's "Available to help" switch: `{ available: boolean }`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const available = (read.body as { available?: unknown } | undefined)?.available;
  if (typeof available !== "boolean") return fail(400, "bad_request", "Expected { available: true | false }.");
  const volunteer = runtime().network.updateVolunteer(id, { available });
  return volunteer ? json({ volunteer }) : fail(404, "not_found", "No volunteer with that id.");
}

import { fail, json } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";
import { inboxFor } from "../../../../../lib/views";

export const dynamic = "force-dynamic";

/** The volunteer's alerts on open incidents. Fetching marks new alerts `shown` (the box and dashboard see it). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const inbox = inboxFor(runtime(), id);
  if (!inbox) return fail(404, "not_found", "No volunteer with that id. The demo server may have restarted; sign up again.");
  return json(inbox);
}

import { ensureRuntime } from "../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * The short EMS link shown on the box screen (`clara.living/r/AB12CD`): redirects to the full scene report. An
 * unknown or ambiguous code is a plain 404; the code never reveals the report token itself.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await ctx.params;
  const rt = await ensureRuntime();
  const token = rt.network.reportTokenByCode(code);
  if (!token) return new Response("Unknown report code.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(null, { status: 307, headers: { location: `/report/${encodeURIComponent(token)}`, "cache-control": "no-store" } });
}

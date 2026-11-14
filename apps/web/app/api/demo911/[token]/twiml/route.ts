import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * The demo dispatcher call's TwiML: plays Clara's Cartesia recording of the briefing (twice), then hangs up. The
 * address holds a random one-time token and expires 30 minutes after the call is placed. Twilio may GET or POST.
 */
async function handle(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const rt = await ensureRuntime();
  const r = rt.demo911.recording(token);
  if (!r) return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, { status: 404, headers: { "content-type": "text/xml" } });
  return new Response(r.twiml, { headers: { "content-type": "text/xml", "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;

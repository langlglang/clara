import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The demo dispatcher call's briefing in Clara's Cartesia voice (8 kHz WAV), behind the call's one-time token. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const rt = await ensureRuntime();
  const r = rt.demo911.recording(token);
  if (!r) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(r.wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

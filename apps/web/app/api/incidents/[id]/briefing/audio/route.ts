import { fail } from "../../../../../../lib/http";
import { requireAdmin } from "../../../../../../lib/admin-auth";
import { briefingLines } from "../../../../../../lib/demo911";
import { ensureRuntime } from "../../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * GET ?line=N: one line of the simulated 911 briefing as a WAV in Clara's Cartesia voice (24 kHz, clearer on a
 * laptop speaker). Cartesia only: 503 without CARTESIA_API_KEY or when Cartesia fails (the page retries and says so).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const n = Number(new URL(req.url).searchParams.get("line") ?? "0");
  const rt = await ensureRuntime();
  if (!rt.speech.available) return fail(503, "server_error", "Cartesia isn't configured on the server (CARTESIA_API_KEY).");
  const b = briefingLines(rt.network, id);
  const line = Number.isInteger(n) ? b?.lines[n] : undefined;
  if (!b || !line) return fail(404, "not_found", "No such line.");
  const wav = await rt.speech.speak(line.text, "en", 24_000, req.signal);
  if (!wav) return fail(503, "server_error", "Cartesia couldn't voice this line right now.");
  return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

import { createCartesiaVoice } from "@clara/agent";
import { fail } from "../../../../../../lib/http";
import { requireAdmin } from "../../../../../../lib/admin-auth";
import { briefingLines } from "../../../../../../lib/demo911";
import { ensureRuntime } from "../../../../../../lib/server";

export const dynamic = "force-dynamic";

/** Clara's voice for the call is made once per incident and briefing text, then reused (in memory). */
const cache = new Map<string, Buffer>();

/**
 * GET ?line=N: one line of the simulated 911 briefing as a WAV in Clara's Cartesia voice (24 kHz, clearer on a
 * laptop speaker). 503 without CARTESIA_API_KEY or when Cartesia fails, so the page falls back to the browser voice.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const n = Number(new URL(req.url).searchParams.get("line") ?? "0");
  const key = process.env.CARTESIA_API_KEY?.trim();
  if (!key) return fail(503, "server_error", "No Cartesia key; use the browser voice.");
  const rt = await ensureRuntime();
  const b = briefingLines(rt.network, id);
  const line = b?.lines[n];
  if (!b || !line || !Number.isInteger(n)) return fail(404, "not_found", "No such line.");
  const cacheKey = `${id}:${n}:${line.text}`;
  let wav = cache.get(cacheKey);
  if (!wav) {
    const voice = createCartesiaVoice({ apiKey: key, sampleRate: 24_000, ...(process.env.CARTESIA_VOICE_ID ? { voiceId: process.env.CARTESIA_VOICE_ID } : {}) });
    wav = (await voice.speak(line.text, "en", AbortSignal.timeout(10_000))) ?? undefined;
    if (!wav) return fail(503, "server_error", "Cartesia couldn't voice this line; use the browser voice.");
    if (cache.size > 200) cache.clear();
    cache.set(cacheKey, wav);
  }
  return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

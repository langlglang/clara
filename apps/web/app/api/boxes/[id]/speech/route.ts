import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fail, issues, readJson } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const SpeechRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(600),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
});

function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given?.startsWith("Bearer ")) return false;
  const a = Buffer.from(given.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One of the box's own lines (fixed lines, step text, greetings) in Clara's Cartesia voice, as a 16 kHz WAV, so the
 * box never has to use its robotic local voice while it is online. The box saves each answer, so lines it has heard
 * once keep Clara's voice offline too. With CLARA_BOX_TOKEN set, only a box with that token may ask.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.network.store.getBox(id)) return fail(404, "not_found", `Unknown box "${id}".`);
  const expected = process.env.CLARA_BOX_TOKEN?.trim();
  if (expected && !tokenMatches(req.headers.get("authorization"), expected)) return fail(403, "forbidden", "Box token required.");
  if (!rt.speech.available) return fail(503, "server_error", "Cartesia isn't configured on the server.");
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const parsed = SpeechRequestSchema.safeParse(read.body);
  if (!parsed.success) return fail(400, "bad_request", "Send { text, language }.", { issues: issues(parsed.error) });
  const wav = await rt.speech.speak(parsed.data.text, parsed.data.language, 16_000, req.signal);
  if (!wav) return fail(503, "server_error", "Cartesia couldn't voice this line right now.");
  return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

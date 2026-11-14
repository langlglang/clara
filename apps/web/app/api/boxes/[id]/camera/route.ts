import { timingSafeEqual } from "node:crypto";
import { CameraInspectRequestSchema, CAMERA_INSPECT_VERSION, type CameraInspectResponse } from "@clara/contracts";
import { createAnthropicVisionInspector } from "@clara/agent";
import { fail, json } from "../../../../../lib/http";
import { ensureRuntime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

const MAX_JPEG_BYTES = 800_000;
const INSPECT_DEADLINE_MS = 4_000;
const MAX_BODY_BYTES = 1_200_000;
const LIMITATION = "This is one camera frame. I may miss details; please describe what you see.";
const used = new Map<string, number>();

function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given?.startsWith("Bearer ")) return false;
  const a = Buffer.from(given.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBoundedJson(req: Request): Promise<unknown | null> {
  if (!req.body || Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch { return null; }
}

/** One consented frame; no body, image, or health details are logged or persisted. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!tokenMatches(req.headers.get("authorization"), process.env.CLARA_BOX_TOKEN)) return fail(403, "forbidden", "Camera upload is not authorized.");
  const rt = await ensureRuntime();
  const box = rt.network.store.getBox(id);
  if (!box) return fail(404, "not_found", "Unknown box.");
  const raw = await readBoundedJson(req);
  const parsed = CameraInspectRequestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.session_id !== box.open_session_id) return fail(400, "bad_request", "Camera request or session is invalid.");
  const request = parsed.data;
  const ageMs = Date.now() - Date.parse(request.captured_at);
  if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > 30_000) return fail(400, "bad_request", "Camera frame is stale.");
  const jpeg = Buffer.from(request.image_base64, "base64");
  const validJpeg = jpeg.length > 100 && jpeg.length <= MAX_JPEG_BYTES && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9;
  if (!validJpeg) { jpeg.fill(0); return fail(400, "bad_request", "Frame is not a bounded JPEG."); }
  const now = Date.now();
  for (const [key, at] of used) if (now - at > 5 * 60_000) used.delete(key);
  const replayKey = `${id}:${request.session_id}:${request.consent_id}`;
  if (used.has(replayKey)) { jpeg.fill(0); return fail(409, "conflict", "This camera grant was already used."); }
  used.set(replayKey, now);
  const timeout = AbortSignal.timeout(INSPECT_DEADLINE_MS);
  const signal = AbortSignal.any([req.signal, timeout]);
  let observation: string | null = null;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) observation = await createAnthropicVisionInspector(apiKey).inspect(request.image_base64, signal);
  } catch {
    // A camera/model failure is unavailable, never a generated fallback observation.
  } finally {
    jpeg.fill(0);
  }
  const response: CameraInspectResponse = {
    schema_version: CAMERA_INSPECT_VERSION,
    task_id: request.task_id,
    status: observation ? "observed" : "unavailable",
    observation,
    limitation: LIMITATION,
    captured_at: request.captured_at,
    observed_at: new Date().toISOString(),
  };
  return json(response);
}

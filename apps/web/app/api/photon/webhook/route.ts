import { ensureRuntime } from "../../../../lib/server";
import { messageFromEvent, verifyWebhook } from "../../../../lib/photon";

export const dynamic = "force-dynamic";

/** webhook-ids already handled (Photon may deliver an event more than once). In memory, like the rest of the demo. */
const seen = new Set<string>();
const MAX_SEEN = 2_000;

/**
 * Photon's inbound-message webhook. Verifies the Standard Webhooks signature (HMAC-SHA256 with PHOTON_WEBHOOK_SECRET
 * over `webhook-id.webhook-timestamp.rawBody`, five-minute window) and returns 400 otherwise. A `message.received`
 * from a volunteer's phone answers their newest open alert or ride offer ("1"/"yes" → coming or drive, "2"/"no" →
 * can't) through the same network.respond / rides.answer paths as the app, and texts back a short confirmation.
 */
export async function POST(req: Request): Promise<Response> {
  const rt = await ensureRuntime();
  const secret = rt.photon?.webhookSecret;
  if (!secret) return new Response("Photon webhooks are not configured.", { status: 403 });
  const body = await req.text().catch(() => "");
  const id = req.headers.get("webhook-id");
  const ok = verifyWebhook(secret, { id, timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") }, body);
  if (!ok || !id) return new Response("Invalid signature.", { status: 400 });
  if (seen.has(id)) return new Response(null, { status: 204 });
  seen.add(id);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Bad JSON.", { status: 400 });
  }
  const { type, message } = messageFromEvent(event);
  if (type && type !== "message.received") return new Response(null, { status: 204 });
  if (!message) return new Response(null, { status: 204 });
  const outcome = rt.texts.inbound(message);
  return Response.json({ outcome });
}

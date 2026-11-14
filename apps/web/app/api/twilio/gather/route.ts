import { runtime } from "../../../../lib/server";
import { gatherReplyTwiml, validTwilioSignature } from "../../../../lib/twilio";

export const dynamic = "force-dynamic";

const twiml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });

/**
 * Twilio posts the key the volunteer pressed during a fallback call. `?alert=&volunteer=`: 1 → coming, 2 → declined,
 * through the same network.respond path as the app. `?ride=&driver=`: 1 → accept, 2 → decline, through the same
 * rides.answer path as the app. Every request must carry a valid X-Twilio-Signature (HMAC-SHA1 with the auth token
 * over PUBLIC_BASE_URL + path + query and the sorted POST params); anything else gets 403.
 */
export async function POST(req: Request): Promise<Response> {
  const rt = runtime();
  if (!rt.twilio) return new Response("Calls are not configured.", { status: 403 });
  const url = new URL(req.url);
  const text = await req.text().catch(() => "");
  const params = Object.fromEntries(new URLSearchParams(text));
  // Behind Render's proxy req.url is the internal address; Twilio signed the public one.
  const signedUrl = `${rt.publicBaseUrl}${url.pathname}${url.search}`;
  if (!validTwilioSignature(rt.twilio.authToken, signedUrl, params, req.headers.get("x-twilio-signature"))) return new Response("Invalid signature.", { status: 403 });

  const digit = params.Digits ?? "";
  const alertId = url.searchParams.get("alert");
  const volunteerId = url.searchParams.get("volunteer");
  const rideId = url.searchParams.get("ride");
  const driverId = url.searchParams.get("driver");

  if (alertId && volunteerId) {
    const action = digit === "1" ? "coming" : digit === "2" ? "declined" : null;
    if (!action) return twiml(gatherReplyTwiml("unknown"));
    try {
      const r = rt.network.respond(alertId, volunteerId, action);
      if (r.outcome === "answered" || r.outcome === "unchanged") return twiml(gatherReplyTwiml(action));
      if (r.outcome === "closed") return twiml(gatherReplyTwiml("closed"));
      return twiml(gatherReplyTwiml("error"));
    } catch {
      return twiml(gatherReplyTwiml("error"));
    }
  }
  if (rideId && driverId) {
    const action = digit === "1" ? "accept" : digit === "2" ? "decline" : null;
    if (!action) return twiml(gatherReplyTwiml("unknown"));
    const r = rt.rides.answer(rideId, driverId, action);
    if (r.outcome === "accepted") return twiml(gatherReplyTwiml("driving"));
    if (r.outcome === "declined") return twiml(gatherReplyTwiml("declined"));
    if (r.outcome === "taken") return twiml(gatherReplyTwiml("taken"));
    if (r.outcome === "closed" || r.outcome === "expired") return twiml(gatherReplyTwiml("closed"));
    return twiml(gatherReplyTwiml("error"));
  }
  return twiml(gatherReplyTwiml("error"), 400);
}

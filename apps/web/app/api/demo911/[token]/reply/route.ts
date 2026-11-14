import { ensureRuntime } from "../../../../../lib/server";
import { validTwilioSignature } from "../../../../../lib/twilio";

export const dynamic = "force-dynamic";

const twiml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });

/**
 * Twilio posts what the demo dispatcher said (SpeechResult) on a simulated 911 call; Clara answers from the scene's
 * facts and listens again (lib/dispatchTalk.ts). The address holds the call's random one-time token, and every
 * request must carry a valid X-Twilio-Signature.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const rt = await ensureRuntime();
  if (!rt.twilio) return new Response("Calls are not configured.", { status: 403 });
  const url = new URL(req.url);
  const text = await req.text().catch(() => "");
  const params = Object.fromEntries(new URLSearchParams(text));
  // Behind Render's proxy req.url is the internal address; Twilio signed the public one.
  const signedUrl = `${rt.publicBaseUrl}${url.pathname}${url.search}`;
  if (!validTwilioSignature(rt.twilio.authToken, signedUrl, params, req.headers.get("x-twilio-signature"))) return new Response("Invalid signature.", { status: 403 });
  return twiml(await rt.demo911.reply(token, params.SpeechResult ?? ""));
}

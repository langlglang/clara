import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio voice over its REST API (plain fetch, no SDK): place one outbound call with inline TwiML, check the
 * X-Twilio-Signature on Twilio's callbacks, and the TwiML Clara says. Clara only ever calls volunteers who gave a
 * number and agreed to calls; it never calls emergency services.
 */

export const TWILIO_TIMEOUT_MS = 8_000;
export const DEFAULT_BASE_URL = "https://clara.living";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export type TwilioEnv = { TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM_NUMBER?: string; PUBLIC_BASE_URL?: string };

/** The Twilio settings when all three are set, else null (calls then only log "would call"). */
export function twilioConfig(env: TwilioEnv): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();
  return accountSid && authToken && from ? { accountSid, authToken, from } : null;
}

/** The public origin Twilio calls back on (no trailing slash). */
export const publicBaseUrl = (env: TwilioEnv) => (env.PUBLIC_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

/** Twilio's request signature: base64 HMAC-SHA1 of the full URL followed by each POST param (sorted by name) as name+value. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** True only when the header matches the signature for this URL and these params (constant-time compare). */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The call: says the emergency (or ride), asks for 1 or 2, repeats once, then says goodbye and hangs up. */
export function callTwiml(spoken: string, gatherUrl: string, kind: "alert" | "ride" = "alert"): string {
  const ask = kind === "ride" ? "Press 1 if you can drive. Press 2 if you can't." : "Press 1 if you can come. Press 2 if you can't.";
  const say = `This is Clara, a first-aid network demo. ${spoken} ${ask}`;
  const gather = `<Gather numDigits="1" action="${xml(gatherUrl)}" method="POST" timeout="6"><Say>${xml(say)}</Say></Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather}${gather}<Say>No answer received. Goodbye.</Say><Hangup/></Response>`;
}

/** What the call says after a key press. */
export function gatherReplyTwiml(kind: "coming" | "driving" | "taken" | "declined" | "closed" | "unknown" | "error"): string {
  const line = {
    coming: "Thank you. The box will tell them you're coming.",
    driving: "Thank you. The box will tell them you're driving. Open the Clara app for directions to the pickup.",
    taken: "Another driver already took this ride. Thank you.",
    declined: "Okay, thank you.",
    closed: "This emergency has already closed. Thank you.",
    unknown: "Sorry, that key isn't an answer. Open the Clara app to respond. Goodbye.",
    error: "Sorry, Clara couldn't record that. Open the Clara app to respond. Goodbye.",
  }[kind];
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(line)}</Say><Hangup/></Response>`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Twilio's text-to-speech call template: the only kind of spoken call a newer trial account may place. */
export const TRIAL_TTS_TEMPLATE = "https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech";
const TRIAL_LIMITED = /trial accounts have limited parameter access/i;

/** The words a TwiML document says, joined (used to hand the same message to the trial template). */
export const spokenText = (twiml: string) =>
  [...twiml.matchAll(/<Say>([\s\S]*?)<\/Say>/g)]
    .map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .filter((t, i, all) => all.indexOf(t) === i)
    .join(" ");

/**
 * Places one outbound call with inline TwiML. A newer Twilio trial account refuses custom TwiML ("trial accounts have
 * limited parameter access"); then the call is retried on Twilio's text-to-speech template, passing the same words as
 * `Message`, so the phone still rings (the template may read its own sample text instead). Resolves with the call sid;
 * throws on a non-2xx or the deadline.
 */
export async function placeCall(
  config: TwilioConfig,
  to: string,
  twiml: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = TWILIO_TIMEOUT_MS,
  /** url: our own TwiML address (e.g. a Cartesia recording), tried first. onRoute says which way the call went. */
  o: { url?: string; onRoute?: (route: "url" | "twiml" | "trial_template") => void } = {},
): Promise<string> {
  const post = async (params: Record<string, string>) => {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls.json`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = (await res.json().catch(() => null)) as { sid?: string; message?: string } | null;
    return { ok: res.ok, status: res.status, sid: body?.sid, message: body?.message ?? "" };
  };
  if (o.url) {
    const own = await post({ To: to, From: config.from, Url: o.url, Method: "GET", Timeout: "25" });
    if (own.ok) {
      o.onRoute?.("url");
      return own.sid ?? "unknown";
    }
    console.log(`[twilio] call with our own TwiML URL refused (${own.status}${own.message ? `: ${own.message.slice(0, 120)}` : ""}); trying inline TwiML`);
  }
  const first = await post({ To: to, From: config.from, Twiml: twiml, Timeout: "25" });
  if (first.ok) {
    o.onRoute?.("twiml");
    return first.sid ?? "unknown";
  }
  if (first.status === 400 && TRIAL_LIMITED.test(first.message)) {
    const url = `${TRIAL_TTS_TEMPLATE}?Message=${encodeURIComponent(spokenText(twiml).slice(0, 1500))}`;
    // Trial calls take only To, the template URL and (maybe) From; try with From first, then without.
    const attempts: Array<Record<string, string>> = [{ To: to, From: config.from, Url: url }, { To: to, Url: url }];
    for (const params of attempts) {
      const retry = await post(params);
      if (retry.ok) {
        o.onRoute?.("trial_template");
        return retry.sid ?? "unknown";
      }
      if (!(retry.status === 400 && TRIAL_LIMITED.test(retry.message))) throw new Error(`Twilio answered ${retry.status} (trial template)${retry.message ? `: ${retry.message}` : ""}`);
    }
  }
  throw new Error(`Twilio answered ${first.status}${first.message ? `: ${first.message}` : ""}`);
}

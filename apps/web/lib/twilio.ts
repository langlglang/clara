import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio voice over its REST API (plain fetch, no SDK): place one outbound call with inline TwiML, check the
 * X-Twilio-Signature on Twilio's callbacks, and the TwiML Clara says. Clara only ever calls volunteers who gave a
 * number and agreed to calls; it never calls emergency services.
 */

export const TWILIO_TIMEOUT_MS = 8_000;
export const DEFAULT_BASE_URL = "https://clara.living";

/**
 * Photon voice: the call still runs on Twilio (our TwiML, Cartesia audio, keypad answers), but it is dialled over SIP
 * to Photon, so the phone rings from the Photon number (photon.codes/docs/beta/cookbooks/voice/twilio).
 */
export interface PhotonSip {
  /** host:port, TLS (e.g. sip.photon.codes:5061). */
  server: string;
  username: string;
  password: string;
  /** The Photon SMS number calls come from (E.164). */
  from: string;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
  /** When set, calls go out through Photon's number first, and through the Twilio number if that fails. */
  photon?: PhotonSip | null;
}

export type TwilioEnv = {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  PUBLIC_BASE_URL?: string;
  PHOTON_SIP_SERVER?: string;
  PHOTON_SIP_USERNAME?: string;
  PHOTON_SIP_PASSWORD?: string;
  PHOTON_VOICE_NUMBER?: string;
};

const E164_NUMBER = /^\+[1-9]\d{7,14}$/;

/** Photon's SIP settings when all four are set and look right, else null. */
export function photonSipConfig(env: TwilioEnv): PhotonSip | null {
  const server = env.PHOTON_SIP_SERVER?.trim().replace(/^sips?:/i, "");
  const username = env.PHOTON_SIP_USERNAME?.trim();
  const password = env.PHOTON_SIP_PASSWORD?.trim();
  const from = env.PHOTON_VOICE_NUMBER?.trim().replace(/[\s().-]/g, "");
  if (!server || !username || !password || !from || !E164_NUMBER.test(from) || !/^[\w.-]+(:\d+)?$/.test(server)) return null;
  return { server, username, password, from };
}

/** The Twilio settings when all three are set, else null (calls then only log "would call"). */
export function twilioConfig(env: TwilioEnv): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();
  return accountSid && authToken && from ? { accountSid, authToken, from, photon: photonSipConfig(env) } : null;
}

/** Twilio's `To` for a call through Photon: the phone number at Photon's SIP server, over TLS. */
export const photonSipTo = (sip: PhotonSip, to: string) => `sip:${to}@${sip.server};transport=tls;secure=true`;

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
  o: { url?: string; onRoute?: (route: "url" | "twiml" | "trial_template") => void; onVia?: (via: "photon" | "twilio") => void } = {},
): Promise<string> {
  if (config.photon) {
    try {
      const sid = await dial(config, to, twiml, fetchImpl, timeoutMs, o, config.photon);
      o.onVia?.("photon");
      return sid;
    } catch (error) {
      console.log(`[twilio] call through Photon failed (${(error as Error).message.slice(0, 160)}); calling from the Twilio number`);
    }
  }
  const sid = await dial(config, to, twiml, fetchImpl, timeoutMs, o, null);
  o.onVia?.("twilio");
  return sid;
}

async function dial(
  config: TwilioConfig,
  to: string,
  twiml: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  o: { url?: string; onRoute?: (route: "url" | "twiml" | "trial_template") => void },
  sip: PhotonSip | null,
): Promise<string> {
  const post = async (raw: Record<string, string>) => {
    // Through Photon: dial the number at Photon's SIP server, from the Photon number, with Photon's outbound login.
    const params = sip ? { ...raw, To: photonSipTo(sip, raw.To ?? to), From: sip.from, SipAuthUsername: sip.username, SipAuthPassword: sip.password } : raw;
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

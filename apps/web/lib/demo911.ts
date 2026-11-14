import type { Network } from "@clara/network";
import { E164, NEED_WORDS, maskPhone } from "./alertText";
import { randomBytes } from "node:crypto";
import { placeCall, type FetchLike, type TwilioConfig } from "./twilio";
import type { ClaraSpeech } from "./speech";
import type { DispatchAnswer, DispatchTurn } from "./dispatchTalk";

/** Two-way talk on the demo call: Clara answers the dispatcher (see dispatchTalk.ts) and can pass messages to the box. */
export interface DispatchTalk {
  answer(incidentId: string, history: readonly DispatchTurn[], words: string): Promise<DispatchAnswer>;
  relay(boxId: string, incidentId: string, text: string): void;
}

/** At most this many dispatcher turns per call. */
export const MAX_DISPATCH_TURNS = 12;
const LISTEN_PROMPT = "You can ask me about the scene, or tell me what to pass on to the bystander.";

/**
 * Demo "911" call. When a box's SOS opens, Clara's mock 911 call rings a demo dispatcher phone (one the team owns)
 * through Twilio and reads a short briefing built only from the box's events. It never dials an emergency number:
 * the target must be a full E.164 number from CLARA_DEMO_911_NUMBER, and emergency short codes are refused.
 */

export const DEMO_911_DELAY_MS = 4_000;

/** Numbers that must never be dialled, whatever the setting says (911, 112, 999, 000, 110, 119, 100–102, 999). */
const EMERGENCY = /^(\+?1?911|\+?112|\+?999|\+?000|\+?110|\+?119|\+?100|\+?101|\+?102|\+?911)$/;

export function demo911Target(raw: string | undefined): string | null {
  const n = raw?.replace(/[\s()-]/g, "").trim();
  if (!n || EMERGENCY.test(n) || !E164.test(n)) return null;
  // A national number that is itself an emergency code (e.g. +1911...) is still refused.
  if (/^\+1?911/.test(n) || /^\+(112|999|000)\d{0,3}$/.test(n)) return null;
  return n;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface Demo911Call {
  incident_id: string;
  box_id: string;
  to: string; // masked
  status: "placed" | "failed" | "not_configured";
  at: string;
  sid?: string;
  error?: string;
  /** How the briefing was voiced: Clara's Cartesia recording, Twilio's own voice (inline TwiML), or the trial template. */
  voice?: "cartesia" | "twilio" | "trial_template";
}

/** How long Twilio may fetch a call's recording after the call is placed. */
const RECORDING_TTL_MS = 30 * 60_000;

/** One spoken line of the call, labelled so the call page can show who is speaking and where a fact came from. */
export interface BriefingLine {
  text: string;
  kind: "intro" | "location" | "need" | "reported" | "timer" | "network" | "time";
}

/** The briefing for one incident: facts from its box's events only, the bystander's words labelled as reported. */
export function briefingLines(network: Network, incidentId: string, timeZone = "America/New_York"): { lines: BriefingLine[]; box_name: string; need: string; opened_at: string; closed: boolean } | null {
  const entry = network.store.getIncident(incidentId);
  const incident = entry?.incident;
  if (!incident || !entry) return null;
  const box = network.store.getBox(incident.box_id)?.box;
  if (!box) return null;
  const events = network.store.eventsForBox(incident.box_id).map((e) => e.event).filter((e) => e.session_id === incident.session_id);
  const heard = [...events].reverse().find((e) => e.type === "report.heard") as { text?: string } | undefined;
  const tq = events.find((e) => e.type === "timer.started" && (e as { timer?: string }).timer === "tourniquet");
  const context = events.find((e) => e.type === "emergency.context" && e.task_id === entry.sos_event_id);
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const alerted = incident.alerts.length;
  const coming = incident.alerts.filter((a) => a.state === "coming" || a.state === "arrived").map((a) => a.volunteer_name);
  const lines: Array<BriefingLine | null> = [
    { kind: "intro", text: "This is Clara, an automated first-aid box. This is a simulated 911 call for a hackathon demo." },
    { kind: "location", text: context?.type === "emergency.context" && context.location.kind === "configured_address"
      ? `The box's configured address is ${context.location.address}; it is not a live GPS fix.`
      : "The box has no configured address available; ask the bystander for their location." },
    { kind: "need", text: `${NEED_WORDS[incident.need] ?? "First aid"}.` },
    heard?.text ? { kind: "reported", text: `The bystander reported: ${heard.text}` } : null,
    tq ? { kind: "timer", text: `The box started a tourniquet guidance timer at ${time(tq.occurred_at)}; application is unconfirmed.` } : null,
    alerted > 0 ? { kind: "network", text: `${alerted} nearby volunteer${alerted === 1 ? " has" : "s have"} been alerted.` } : null,
    coming.length > 0 ? { kind: "network", text: `${coming.join(" and ")} accepted and ${coming.length === 1 ? "is" : "are"} on the way.` } : null,
    { kind: "time", text: `SOS opened at ${time(incident.opened_at)}.` },
  ];
  return { lines: lines.filter((l): l is BriefingLine => l !== null), box_name: box.name, need: incident.need, opened_at: incident.opened_at, closed: incident.closed !== null };
}

/** The most recently opened incident's id (the call page's "latest"). */
export function latestIncidentId(entries: Array<{ incident: { incident_id: string; opened_at: string } }>): string | null {
  const latest = [...entries].sort((a, b) => b.incident.opened_at.localeCompare(a.incident.opened_at))[0];
  return latest?.incident.incident_id ?? null;
}

/** The spoken briefing for a box's open incident (the Twilio call reads this). */
export function briefing(network: Network, boxId: string, _now?: Date, timeZone = "America/New_York"): string | null {
  const open = network.store.openIncidentForBox(boxId)?.incident;
  if (!open) return null;
  const lines = briefingLines(network, open.incident_id, timeZone)?.lines;
  if (!lines) return null;
  const time = (_now ?? new Date()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `${lines.map((l) => l.text).join(" ")} This one-time briefing was assembled at ${time}; later updates are not included.`;
}

export function demo911Twiml(spoken: string): string {
  const say = `<Say>${xml(spoken)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="1"/><Say>Repeating.</Say>${say}<Say>End of simulated call. Goodbye.</Say><Hangup/></Response>`;
}

export interface Demo911 {
  /** The TwiML and Cartesia recording behind one call's private address, while it is valid. */
  recording(token: string): { twiml: string; wav: Buffer } | null;
  /** The TwiML answering what the dispatcher just said on a call (Twilio's speech result). */
  reply(token: string, words: string): Promise<string>;
  readonly configured: boolean;
  readonly target: string | null; // masked
  log(): Demo911Call[];
  stop(): void;
}

export function createDemo911({
  network,
  twilio,
  number,
  fetch: fetchImpl = fetch,
  log = console.log,
  delayMs = DEMO_911_DELAY_MS,
  timers = true,
  onCall,
  speech = null,
  baseUrl = null,
  talk = null,
}: {
  /** When present (and baseUrl is https), the dispatcher can talk back after the briefing. */
  talk?: DispatchTalk | null;
  network: Network;
  twilio: TwilioConfig | null;
  number: string | undefined;
  /** Clara's Cartesia voice; when present (and baseUrl is https) the phone hears Clara, not Twilio's voice. */
  speech?: ClaraSpeech | null;
  /** The public https address Twilio fetches the recording from. */
  baseUrl?: string | null;
  fetch?: FetchLike;
  log?: (line: string) => void;
  delayMs?: number;
  timers?: boolean;
  onCall?: (call: Demo911Call) => void;
}): Demo911 & { fire(boxId: string): Promise<Demo911Call | null> } {
  const to = demo911Target(number);
  const calls: Demo911Call[] = [];
  const called = new Set<string>();
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const recordings = new Map<string, { twiml: string; wav: Buffer; expires: number }>();
  const conversations = new Map<string, { incident_id: string; box_id: string; history: DispatchTurn[]; expires: number }>();
  const canTalk = () => Boolean(talk && baseUrl?.startsWith("https://"));

  /** Listens for the dispatcher (speech), posting what they said to the call's reply address; then says goodbye. */
  const listen = (token: string, prompt: string | null) => {
    const action = `${baseUrl}/api/demo911/${token}/reply`;
    const gather = (say: string | null) => `<Gather input="speech" action="${xml(action)}" method="POST" speechTimeout="auto" timeout="10" language="en-US" actionOnEmptyResult="false">${say ? `<Say>${xml(say)}</Say>` : ""}</Gather>`;
    return `${gather(prompt)}${gather("Are you still there? You can ask me about the scene.")}<Say>No more questions heard. End of simulated call. Goodbye.</Say><Hangup/>`;
  };

  /** Clara's voice for a line: a Cartesia recording behind a one-time address, or Twilio's voice. */
  async function voiced(text: string): Promise<string> {
    if (speech?.available && baseUrl?.startsWith("https://")) {
      const wav = await speech.speak(text, "en", 8_000, AbortSignal.timeout(6_000)).catch(() => null);
      if (wav) {
        const now = Date.now();
        const token = randomBytes(24).toString("base64url");
        recordings.set(token, { twiml: "", wav, expires: now + RECORDING_TTL_MS });
        return `<Play>${xml(`${baseUrl}/api/demo911/${token}/audio`)}</Play>`;
      }
    }
    return `<Say>${xml(text)}</Say>`;
  }

  /** A conversation for one call; the token is the call's private reply address. */
  function startConversation(incidentId: string, boxId: string): string {
    const now = Date.now();
    for (const [k, c] of conversations) if (c.expires < now) conversations.delete(k);
    const token = randomBytes(24).toString("base64url");
    conversations.set(token, { incident_id: incidentId, box_id: boxId, history: [], expires: now + RECORDING_TTL_MS });
    return token;
  }

  /** Clara's Cartesia voice for the call, behind a private one-time address; null when it can't be made. */
  async function recordingUrl(spoken: string, talkToken: string | null): Promise<string | null> {
    if (!speech?.available || !baseUrl?.startsWith("https://")) return null;
    const wav = await speech.speak(spoken, "en", 8_000);
    if (!wav) return null;
    const now = Date.now();
    for (const [k, r] of recordings) if (r.expires < now) recordings.delete(k);
    const token = randomBytes(24).toString("base64url");
    const audio = `${baseUrl}/api/demo911/${token}/audio`;
    const twiml = talkToken
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${xml(audio)}</Play>${listen(talkToken, LISTEN_PROMPT)}</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${xml(audio)}</Play><Pause length="1"/><Play>${xml(audio)}</Play><Hangup/></Response>`;
    recordings.set(token, { twiml, wav, expires: now + RECORDING_TTL_MS });
    return `${baseUrl}/api/demo911/${token}/twiml`;
  }

  const record = (call: Demo911Call) => {
    calls.unshift(call);
    calls.length = Math.min(calls.length, 20);
    onCall?.(call);
    return call;
  };

  async function fire(boxId: string): Promise<Demo911Call | null> {
    const incident = network.store.openIncidentForBox(boxId)?.incident;
    if (!incident || called.has(incident.incident_id)) return null;
    called.add(incident.incident_id);
    const at = new Date().toISOString();
    if (!to || !twilio) {
      log(`[demo-911] SOS at ${boxId}: no demo dispatcher call (${!to ? "CLARA_DEMO_911_NUMBER not set or invalid" : "Twilio not configured"})`);
      return record({ incident_id: incident.incident_id, box_id: boxId, to: to ? maskPhone(to) : "-", status: "not_configured", at });
    }
    const spoken = briefing(network, boxId, new Date());
    if (!spoken) return null;
    try {
      const talkToken = canTalk() ? startConversation(incident.incident_id, boxId) : null;
      const url = await recordingUrl(spoken, talkToken);
      const went: { route: "url" | "twiml" | "trial_template" } = { route: "twiml" };
      const inline = talkToken
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(spoken)}</Say>${listen(talkToken, LISTEN_PROMPT)}</Response>`
        : demo911Twiml(spoken);
      const sid = await placeCall(twilio, to, inline, fetchImpl, undefined, { ...(url ? { url } : {}), onRoute: (r) => (went.route = r) });
      const route = went.route;
      const voice = route === "url" ? "cartesia" : route === "twiml" ? "twilio" : "trial_template";
      log(`[demo-911] SOS at ${boxId}: called the demo dispatcher ${maskPhone(to)} (${sid}, voice: ${voice}${url ? "" : ", no Cartesia recording"})`);
      return record({ incident_id: incident.incident_id, box_id: boxId, to: maskPhone(to), status: "placed", at, sid, voice });
    } catch (error) {
      const message = (error as Error).message.slice(0, 160);
      log(`[demo-911] SOS at ${boxId}: call to ${maskPhone(to)} failed: ${message}`);
      return record({ incident_id: incident.incident_id, box_id: boxId, to: maskPhone(to), status: "failed", at, error: message });
    }
  }

  const unsubscribe = network.subscribe((change) => {
    if (change.kind !== "event" || change.event.type !== "sos.opened") return;
    const boxId = change.event.box_id;
    if (!timers) return;
    // A short wait so the first wave of volunteer alerts is in the briefing.
    const t = setTimeout(() => {
      pending.delete(t);
      void fire(boxId);
    }, delayMs);
    pending.add(t);
  });

  return {
    configured: Boolean(to && twilio),
    target: to ? maskPhone(to) : null,
    log: () => calls.map((c) => ({ ...c })),
    async reply(token, words) {
      const hangup = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This simulated call has ended. Goodbye.</Say><Hangup/></Response>`;
      const c = conversations.get(token);
      if (!c || c.expires < Date.now() || !talk) return hangup;
      const said = words.trim().slice(0, 500);
      if (!said) return `<?xml version="1.0" encoding="UTF-8"?><Response>${listen(token, null)}</Response>`;
      const turns = c.history.filter((t) => t.from === "dispatcher").length;
      if (turns >= MAX_DISPATCH_TURNS) return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>That's all I can take on this simulated call. Goodbye.</Say><Hangup/></Response>`;
      const answer = await talk.answer(c.incident_id, c.history, said);
      c.history.push({ from: "dispatcher", text: said }, { from: "clara", text: answer.reply });
      if (answer.relay) {
        try {
          talk.relay(c.box_id, c.incident_id, answer.relay);
        } catch (error) {
          log(`[demo-911] couldn't pass the dispatcher's message to ${c.box_id}: ${(error as Error).message}`);
        }
      }
      log(`[demo-911] dispatcher turn ${turns + 1} on ${c.incident_id}${answer.relay ? " (relayed to the box)" : ""}${answer.end ? " (end)" : ""}`);
      const spokenReply = await voiced(answer.reply);
      return answer.end
        ? `<?xml version="1.0" encoding="UTF-8"?><Response>${spokenReply}<Say>End of simulated call. Goodbye.</Say><Hangup/></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response>${spokenReply}${listen(token, null)}</Response>`;
    },
    recording(token) {
      const r = recordings.get(token);
      return r && r.expires >= Date.now() ? { twiml: r.twiml, wav: r.wav } : null;
    },
    fire,
    stop() {
      unsubscribe();
      for (const t of pending) clearTimeout(t);
      pending.clear();
    },
  };
}

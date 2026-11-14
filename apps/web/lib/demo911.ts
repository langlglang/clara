import type { Network } from "@clara/network";
import { E164, NEED_WORDS, maskPhone } from "./alertText";
import { placeCall, type FetchLike, type TwilioConfig } from "./twilio";

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
}

/** The spoken briefing: facts from the box's events only, labelled as reported where they came from the bystander. */
export function briefing(network: Network, boxId: string, now: Date, timeZone = "America/New_York"): string | null {
  const box = network.store.getBox(boxId)?.box;
  const open = network.store.openIncidentForBox(boxId)?.incident;
  if (!box || !open) return null;
  const events = network.store.eventsForBox(boxId).map((e) => e.event).filter((e) => e.session_id === open.session_id);
  const heard = [...events].reverse().find((e) => e.type === "report.heard") as { text?: string } | undefined;
  const tq = events.find((e) => e.type === "timer.started" && (e as { timer?: string }).timer === "tourniquet");
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const alerted = open.alerts.length;
  const coming = open.alerts.filter((a) => a.state === "coming" || a.state === "arrived").map((a) => a.volunteer_name);
  const parts = [
    "This is Clara, an automated first-aid box. This is a simulated 911 call for a hackathon demo.",
    `Emergency at ${box.name}. ${box.directions}`,
    `${NEED_WORDS[open.need] ?? "First aid"}.`,
    heard?.text ? `The bystander reported: ${heard.text}` : "",
    tq ? `A tourniquet was applied at ${time(tq.occurred_at)}.` : "",
    alerted > 0 ? `${alerted} nearby volunteer${alerted === 1 ? " has" : "s have"} been alerted.` : "",
    coming.length > 0 ? `${coming.join(" and ")} accepted and ${coming.length === 1 ? "is" : "are"} on the way.` : "",
    `SOS opened at ${time(open.opened_at)}.`,
  ];
  void now;
  return parts.filter(Boolean).join(" ");
}

export function demo911Twiml(spoken: string): string {
  const say = `<Say>${xml(spoken)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="1"/><Say>Repeating.</Say>${say}<Say>End of simulated call. Goodbye.</Say><Hangup/></Response>`;
}

export interface Demo911 {
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
}: {
  network: Network;
  twilio: TwilioConfig | null;
  number: string | undefined;
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
      const sid = await placeCall(twilio, to, demo911Twiml(spoken), fetchImpl);
      log(`[demo-911] SOS at ${boxId}: called the demo dispatcher ${maskPhone(to)} (${sid})`);
      return record({ incident_id: incident.incident_id, box_id: boxId, to: maskPhone(to), status: "placed", at, sid });
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
    fire,
    stop() {
      unsubscribe();
      for (const t of pending) clearTimeout(t);
      pending.clear();
    },
  };
}

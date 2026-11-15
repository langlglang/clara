import type { Network } from "@clara/network";
import { reportLinks } from "@clara/network";
import { E164, maskPhone } from "./alertText";
import { briefingLines } from "./demo911";
import { openSmsThread, sendText, textable, type PhotonConfig } from "./photon";
import type { FetchLike } from "./twilio";

/**
 * The written brief, texted from Clara's Photon number: to the demo dispatcher once Clara's call has gone out, and to
 * each volunteer when they say they're coming. Same facts as the call (box events only, the bystander's words marked
 * as reported) plus the live report link, so whoever picks up has it in writing. Never sent to emergency services.
 */

export interface BriefText {
  incident_id: string;
  to: string; // masked
  who: "dispatcher" | "volunteer";
  status: "sent" | "failed" | "not_configured";
  at: string;
  error?: string;
}

const MAX_CHARS = 700;

export function briefText(network: Network, incidentId: string, baseUrl: string, timeZone = "America/New_York"): string | null {
  const b = briefingLines(network, incidentId, timeZone);
  const incident = network.store.getIncident(incidentId)?.incident;
  if (!b || !incident) return null;
  const facts = b.lines.filter((l) => l.kind !== "intro").map((l) => l.text);
  const { short_url } = reportLinks(incident, baseUrl);
  const head = `CLARA BRIEF (demo) · ${b.box_name}`;
  const tail = `Live report: ${short_url}`;
  let body = facts.join(" ");
  const room = MAX_CHARS - head.length - tail.length - 4;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  return `${head}\n${body}\n${tail}`;
}

export interface BriefBook {
  readonly configured: boolean;
  log(): BriefText[];
  /** Text the brief to the demo dispatcher (called after Clara's call is placed). */
  dispatcher(incidentId: string, to: string): Promise<BriefText | null>;
  stop(): void;
}

export function createBriefBook({
  network,
  photon,
  fromNumber,
  baseUrl,
  fetch: fetchImpl = fetch,
  log = (line: string) => console.log(line),
}: {
  network: Network;
  photon: PhotonConfig | null;
  /** Clara's Photon SMS number (PHOTON_VOICE_NUMBER). */
  fromNumber: string | null;
  baseUrl: string;
  fetch?: FetchLike;
  log?: (line: string) => void;
}): BriefBook {
  const sent = new Set<string>();
  const entries: BriefText[] = [];
  const ready = Boolean(photon && fromNumber && E164.test(fromNumber));

  async function send(incidentId: string, to: string, who: BriefText["who"]): Promise<BriefText | null> {
    const key = `${incidentId}/${to}`;
    if (sent.has(key)) return null;
    sent.add(key);
    const entry: BriefText = { incident_id: incidentId, to: maskPhone(to), who, status: "sent", at: network.clock().toISOString() };
    entries.unshift(entry);
    entries.length = Math.min(entries.length, 30);
    const text = briefText(network, incidentId, baseUrl);
    if (!text) {
      entries.shift();
      return null;
    }
    if (!ready || !photon || !fromNumber) {
      entry.status = "not_configured";
      log(`[brief] would text the ${who} ${entry.to} the brief (Photon or PHOTON_VOICE_NUMBER not set).`);
      return entry;
    }
    try {
      const thread = await openSmsThread(photon, fromNumber, to, fetchImpl);
      await sendText(photon, thread, text, fetchImpl);
      log(`[brief] texted the ${who} ${entry.to} the brief for ${incidentId}.`);
    } catch (error) {
      entry.status = "failed";
      entry.error = (error as Error).message.slice(0, 160);
      log(`[brief] couldn't text the ${who} ${entry.to}: ${entry.error}`);
    }
    return entry;
  }

  // A volunteer who says they're coming (or arrives) gets the brief once per incident.
  const unsubscribe = network.subscribe((change) => {
    if (change.kind !== "incident") return;
    const incident = change.incident;
    if (incident.closed) return;
    for (const a of incident.alerts) {
      if (a.state !== "coming" && a.state !== "arrived") continue;
      const v = network.store.getVolunteer(a.volunteer_id);
      if (v && textable(v)) void send(incident.incident_id, v.phone, "volunteer");
    }
  });

  return {
    configured: ready,
    log: () => entries.map((e) => ({ ...e })),
    dispatcher: (incidentId, to) => send(incidentId, to, "dispatcher"),
    stop: unsubscribe,
  };
}

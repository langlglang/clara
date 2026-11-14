import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Alert, Volunteer } from "@clara/contracts";
import type { Network } from "@clara/network";
import { alertWords, E164, inQuietHours, maskPhone, NEED_WORDS, rideWords } from "./alertText";
import type { Ride, RideBook } from "./rides";
import type { FetchLike } from "./twilio";

/**
 * Text alerts over Photon (photon.codes, Beta / 2.0 API, plain fetch): a volunteer whose channel is imessage,
 * whatsapp or sms and who gave an E.164 number gets each alert and ride offer as a text, and answers "1" / "2".
 *
 * Shapes come from https://api.photon.codes/openapi.json: POST /v1/projects/{id}/messages takes
 * { spaceId, senderId, content: { type: "text", format: "plain", text } } and a required Idempotency-Key header.
 * A shared iMessage line can't send a first message: it only answers a peer with an active assignment who has
 * messaged it. So Clara texts a volunteer in the Space of their last message to the line (remembered from the
 * inbound webhook, else looked up with GET /v1/projects/{id}/messages); with no such thread it logs "no_thread".
 * Inbound webhooks use Standard Webhooks signatures (photon.codes/docs/beta/message-delivery/webhook.md).
 */

export const PHOTON_BASE_URL = "https://api.photon.codes";
export const PHOTON_TIMEOUT_MS = 8_000;
const MAX_LOG = 30;
const WEBHOOK_TOLERANCE_S = 5 * 60;

export interface PhotonConfig {
  apiKey: string;
  projectId: string;
  /** whsec_… from the webhook destination; null: inbound webhooks are refused. */
  webhookSecret: string | null;
  baseUrl: string;
}

export type PhotonEnv = { PHOTON_API_KEY?: string; PHOTON_PROJECT_ID?: string; PHOTON_WEBHOOK_SECRET?: string; PHOTON_BASE_URL?: string };

/** Photon settings when the key and project id are set, else null (texts then only log "would message"). */
export function photonConfig(env: PhotonEnv): PhotonConfig | null {
  const apiKey = env.PHOTON_API_KEY?.trim();
  const projectId = env.PHOTON_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId, webhookSecret: env.PHOTON_WEBHOOK_SECRET?.trim() || null, baseUrl: (env.PHOTON_BASE_URL?.trim() || PHOTON_BASE_URL).replace(/\/+$/, "") };
}

export type TextPlatform = "imessage" | "whatsapp" | "sms";

/** May Clara text this volunteer? They chose a text channel and gave an E.164 number. */
export const textable = (v: Volunteer): v is Volunteer & { phone: string; channel: TextPlatform } => v.channel !== "app" && typeof v.phone === "string" && E164.test(v.phone);

// ---------- words ----------

export function alertTextMessage(network: Network, alert: Alert): string | null {
  const w = alertWords(network, alert);
  if (!w) return null;
  const where = w.distance ? `${w.box_name}, ${w.distance}${w.minutes !== null ? ` (~${Math.max(1, w.minutes)} min)` : ""}` : w.box_name;
  return `CLARA ALERT (demo): ${NEED_WORDS[w.need] ?? "Emergency"} at ${where}. Reply 1 if you're coming, 2 if you can't.`;
}

export function rideTextMessage(network: Network, ride: Ride, driverId: string): string | null {
  const w = rideWords(network, ride, driverId);
  if (!w) return null;
  return `RIDE NEEDED (demo): ${w.box_name} to ${w.hospital}, ${w.seats} seat${w.seats === 1 ? "" : "s"}${w.distance ? `, pickup ${w.distance} from you` : ""}. Reply 1 to drive, 2 if not.`;
}

export const HELP_TEXT = "This is Clara (demo). Reply 1 if you're coming (or can drive), 2 if you can't. Open the Clara app for details.";

/** "1", "yes", "coming", "y", "ok" → yes; "2", "no", "n", "can't" → no; anything else null. */
export function parseReply(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (/^(1|y|yes|yep|yeah|ok|okay|coming|i'?m coming|on my way|omw|drive|i can drive)$/.test(t)) return "yes";
  if (/^(2|n|no|nope|can'?t|cannot|can not|not coming|decline)$/.test(t)) return "no";
  return null;
}

// ---------- REST ----------

async function photonFetch<T>(config: PhotonConfig, fetchImpl: FetchLike, method: string, path: string, body?: unknown, timeoutMs = PHOTON_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}`, accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `clara-${randomUUID()}`;
  }
  const res = await fetchImpl(`${config.baseUrl}/v1/projects/${encodeURIComponent(config.projectId)}${path}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as (T & { title?: string; detail?: string }) | null;
  if (!res.ok) throw new Error(`Photon answered ${res.status}${json?.title ? `: ${json.title}` : ""}${json?.detail ? ` (${String(json.detail).slice(0, 120)})` : ""}`);
  return json as T;
}

/** Where to text one volunteer: the Space of their thread with the line and the line's agent User id. */
export interface Thread {
  spaceId: string;
  senderId: string;
  platform: string;
}

/** Sends one plain text into a Space. Resolves with the message id. */
export async function sendText(config: PhotonConfig, thread: Thread, text: string, fetchImpl: FetchLike = fetch, parentMessageId?: string): Promise<string> {
  const r = await photonFetch<{ id?: string }>(config, fetchImpl, "POST", "/messages", {
    spaceId: thread.spaceId,
    senderId: thread.senderId,
    content: { type: "text", format: "plain", text },
    ...(parentMessageId ? { parentMessageId } : {}),
  });
  return r?.id ?? "unknown";
}

/** The fields Clara reads from a Photon Message (GET messages item, or the message inside a webhook event). */
export interface InboundMessage {
  id: string;
  platform?: string;
  status?: string;
  content?: { type?: string; format?: string; text?: string };
  sentBy?: { id?: string; handle?: string; kind?: string };
  receivedBy?: { id?: string; handle?: string; kind?: string };
  space?: { id?: string };
}

/** The last message this phone sent the project on this platform, from GET /messages (newest first). */
export async function findThread(config: PhotonConfig, phone: string, platform: TextPlatform, fetchImpl: FetchLike = fetch): Promise<Thread | null> {
  const q = new URLSearchParams({ direction: "received", platform, order: "desc", pageSize: "100" });
  const page = await photonFetch<{ items?: InboundMessage[] }>(config, fetchImpl, "GET", `/messages?${q}`);
  const m = (page?.items ?? []).find((x) => x.sentBy?.handle === phone && x.space?.id && x.receivedBy?.id);
  return m ? { spaceId: m.space!.id!, senderId: m.receivedBy!.id!, platform: m.platform ?? platform } : null;
}

// ---------- webhook signatures (Standard Webhooks) ----------

/** "v1,<base64>" of HMAC-SHA256 over `${id}.${timestamp}.${body}` with the base64-decoded part of whsec_…. */
export function webhookSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64")}`;
}

/** True when one of the space-separated signatures matches and the timestamp is within five minutes. */
export function verifyWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = Buffer.from(webhookSignature(secret, id, timestamp, body).slice(3));
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Finds the message in a webhook event body (the event's data, or data.message), defensively. */
export function messageFromEvent(event: unknown): { type: string | null; message: InboundMessage | null } {
  const e = (event ?? {}) as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : null;
  const data = e.data as Record<string, unknown> | undefined;
  for (const c of [data?.message, data?.object, data, e.message, e]) {
    const m = c as InboundMessage | undefined;
    if (m && typeof m === "object" && typeof m.id === "string" && m.sentBy && m.space) return { type, message: m };
  }
  return { type, message: null };
}

// ---------- the text book ----------

export type TextStatus = "sent" | "failed" | "would_message" | "quiet" | "no_thread";

export interface TextLogEntry {
  /** Alert id, ride id, or "reply". */
  ref: string;
  kind: "alert" | "ride" | "reply";
  volunteer_id: string;
  to: string;
  status: TextStatus;
  at: string;
  detail?: string;
}

export type ReplyOutcome = "coming" | "declined" | "driving" | "ride_declined" | "taken" | "closed" | "nothing_open" | "help" | "unknown_sender" | "error";

export interface TextBook {
  readonly configured: boolean;
  /** Text one volunteer about an alert that just went out (gates applied here). */
  alert(alert: Alert): void;
  /** Text one driver about a ride offer (gates applied here). */
  ride(ride: Ride, driverId: string): void;
  /** Handle one inbound message: map sender → volunteer → latest open alert/offer, answer it, reply. */
  inbound(message: InboundMessage): ReplyOutcome;
  recent(): TextLogEntry[];
  idle(): Promise<void>;
}

export interface TextBookOptions {
  network: Network;
  rides?: Pick<RideBook, "list" | "answer">;
  photon: PhotonConfig | null;
  fetch?: FetchLike;
  log?: (line: string) => void;
}

const REPLY_WORDS: Record<ReplyOutcome, string> = {
  coming: "Thank you. The box will tell them you're coming. Open the Clara app for directions.",
  declined: "Okay, thank you.",
  driving: "Thank you. The box will tell them you're driving. Open the Clara app for directions to the pickup.",
  ride_declined: "Okay, thank you.",
  taken: "Another driver already took this ride. Thank you.",
  closed: "This emergency has already closed. Thank you.",
  nothing_open: "There's nothing open for you to answer right now. Thank you.",
  help: HELP_TEXT,
  unknown_sender: "This number isn't linked to a Clara volunteer. Add it in your Clara profile and choose texts.",
  error: "Sorry, Clara couldn't record that. Open the Clara app to respond.",
};

export function createTextBook({ network, rides, photon, fetch: fetchImpl = fetch, log = console.log }: TextBookOptions): TextBook {
  const threads = new Map<string, Thread>();
  const entries: TextLogEntry[] = [];
  const pending = new Set<Promise<unknown>>();
  const told = new Set<string>();

  const record = (e: TextLogEntry) => {
    entries.unshift(e);
    entries.length = Math.min(entries.length, MAX_LOG);
    return e;
  };
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  function deliver(kind: "alert" | "ride", ref: string, volunteer: Volunteer & { phone: string; channel: TextPlatform }, text: string) {
    const base = { ref, kind, volunteer_id: volunteer.volunteer_id, to: maskPhone(volunteer.phone), at: network.clock().toISOString() };
    if (!photon) {
      record({ ...base, status: "would_message" });
      log(`[photon] would message ${base.to} over ${volunteer.channel} for ${kind} ${ref} (Photon not configured).`);
      return;
    }
    const entry = record({ ...base, status: "sent" });
    const run = (async () => {
      try {
        const thread = threads.get(volunteer.phone) ?? (await findThread(photon, volunteer.phone, volunteer.channel, fetchImpl));
        if (!thread) {
          entry.status = "no_thread";
          log(`[photon] can't text ${base.to} yet: they haven't messaged the Clara line on ${volunteer.channel}.`);
          return;
        }
        threads.set(volunteer.phone, thread);
        await sendText(photon, thread, text, fetchImpl);
        log(`[photon] texted ${base.to} for ${kind} ${ref}.`);
      } catch (error) {
        entry.status = "failed";
        entry.detail = (error as Error).message.slice(0, 160);
        log(`[photon] text to ${base.to} failed: ${entry.detail}`);
      }
    })();
    track(run);
  }

  function gate(volunteerId: string, key: string): (Volunteer & { phone: string; channel: TextPlatform }) | null {
    if (told.has(key)) return null;
    told.add(key);
    const v = network.store.getVolunteer(volunteerId);
    if (!v || !textable(v)) return null;
    if (inQuietHours(v.quiet_hours, network.clock())) {
      record({ ref: key, kind: key.startsWith("ride/") ? "ride" : "alert", volunteer_id: v.volunteer_id, to: maskPhone(v.phone), status: "quiet", at: network.clock().toISOString() });
      return null;
    }
    return v;
  }

  /** The volunteer's newest open item: an alert still sent/shown in an open incident, or a ride offer still offered. */
  function latestOpen(volunteerId: string): { kind: "alert"; alert: Alert; at: number } | { kind: "ride"; ride: Ride; at: number } | null {
    let best: { kind: "alert"; alert: Alert; at: number } | { kind: "ride"; ride: Ride; at: number } | null = null;
    for (const { incident } of network.store.listIncidents()) {
      if (incident.closed !== null) continue;
      for (const a of incident.alerts) {
        if (a.volunteer_id !== volunteerId || (a.state !== "sent" && a.state !== "shown")) continue;
        const at = Date.parse(a.sent_at);
        if (!best || at > best.at) best = { kind: "alert", alert: a, at };
      }
    }
    for (const r of rides?.list() ?? []) {
      if (r.state !== "offered" || r.winner) continue;
      for (const f of r.offers) {
        if (f.driver_id !== volunteerId || f.state !== "offered") continue;
        const at = Date.parse(f.offered_at);
        if (!best || at > best.at) best = { kind: "ride", ride: r, at };
      }
    }
    return best;
  }

  function answer(volunteerId: string, reply: "yes" | "no"): ReplyOutcome {
    const open = latestOpen(volunteerId);
    if (!open) return "nothing_open";
    try {
      if (open.kind === "alert") {
        const action = reply === "yes" ? "coming" : "declined";
        const r = network.respond(open.alert.alert_id, volunteerId, action);
        if (r.outcome === "answered" || r.outcome === "unchanged") return action;
        return r.outcome === "closed" ? "closed" : "error";
      }
      const r = rides!.answer(open.ride.ride_id, volunteerId, reply === "yes" ? "accept" : "decline");
      if (r.outcome === "accepted") return "driving";
      if (r.outcome === "declined") return "ride_declined";
      if (r.outcome === "taken") return "taken";
      if (r.outcome === "closed" || r.outcome === "expired") return "closed";
      return "error";
    } catch {
      return "error";
    }
  }

  return {
    configured: photon !== null,
    alert(alert) {
      const v = gate(alert.volunteer_id, `alert/${alert.alert_id}`);
      if (!v) return;
      const text = alertTextMessage(network, alert);
      if (text) deliver("alert", alert.alert_id, v, text);
    },
    ride(ride, driverId) {
      const offer = ride.offers.find((f) => f.driver_id === driverId);
      const v = gate(driverId, `ride/${ride.ride_id}/${driverId}/${offer?.offered_at ?? ""}`);
      if (!v) return;
      const text = rideTextMessage(network, ride, driverId);
      if (text) deliver("ride", ride.ride_id, v, text);
    },
    inbound(message) {
      const phone = message.sentBy?.handle ?? "";
      if (message.sentBy?.kind === "agent" || (message.status && message.status !== "received")) return "help";
      const thread: Thread | null = message.space?.id && message.receivedBy?.id ? { spaceId: message.space.id, senderId: message.receivedBy.id, platform: message.platform ?? "imessage" } : null;
      if (thread && phone) threads.set(phone, thread);
      const volunteer = network.store.listVolunteers().find((v) => v.phone === phone);
      const text = message.content?.type === "text" ? message.content.text ?? "" : "";
      const reply = parseReply(text);
      const outcome: ReplyOutcome = !volunteer ? "unknown_sender" : reply === null ? "help" : answer(volunteer.volunteer_id, reply);
      if (photon && thread) {
        const entry = record({ ref: "reply", kind: "reply", volunteer_id: volunteer?.volunteer_id ?? "unknown", to: maskPhone(phone), status: "sent", at: network.clock().toISOString(), detail: outcome });
        track(
          sendText(photon, thread, REPLY_WORDS[outcome], fetchImpl, message.id).catch((error: Error) => {
            entry.status = "failed";
            log(`[photon] reply to ${entry.to} failed: ${error.message.slice(0, 160)}`);
          }),
        );
      }
      log(`[photon] reply from ${maskPhone(phone)}: ${outcome}.`);
      return outcome;
    },
    recent: () => entries.map((e) => ({ ...e })),
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

/** Wires the text book to the network (alert `sent` pushes) and returns a ride-change listener for the runtime. */
export function wireTexts(network: Network, texts: TextBook): (change: { kind: string; ride?: Ride }) => void {
  network.subscribe((change) => {
    if (change.kind !== "push" || change.push.type !== "alert.update" || change.push.alert.state !== "sent") return;
    texts.alert(change.push.alert);
  });
  return (change) => {
    if (change.kind !== "ride" || !change.ride) return;
    for (const f of change.ride.offers) if (f.state === "offered") texts.ride(change.ride, f.driver_id);
  };
}

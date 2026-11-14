// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/help.ts and the help-request
// steps of services/cloud-api/src/walker/store.ts (askForHelp / answerHelp / helpOf / expireHelp).
// Sophi's one request to a caretaker circle (sent_to → shown_to → coming → closed, first close wins, expiry,
// answers to a closed request refused) becomes one incident with one alert per nearby volunteer. The escalation
// ladder and "one answer per alert" follow ideas from Standard Response (Cal Hacks); no code from it.
import { BoxPushSchema, comingLine, type Alert, type AlertResponse, type BoxPush, type Incident } from "@clara/contracts";
import { ESCALATE_ALL_MS, ESCALATE_NEXT_MS, FIRST_WAVE, INCIDENT_OPEN_MAX_MS, NEARBY_BOX_KM, NEXT_WAVE, type Ids } from "./config.js";
import { estimateEta, haversineKm, rankVolunteers, type Candidate } from "./matching.js";
import type { IncidentEntry, Store } from "./store.js";

/** A message for one box's live stream. */
export interface Push {
  box_id: string;
  push: BoxPush;
}

export interface AlertContext {
  store: Store;
  ids: Ids;
}

const push = (box_id: string, message: BoxPush): Push => ({ box_id, push: BoxPushSchema.parse(message) });
const alertUpdate = (incident: Incident, alert: Alert): Push => push(incident.box_id, { type: "alert.update", incident_id: incident.incident_id, alert });

const LIVE: ReadonlySet<Alert["state"]> = new Set(["coming", "arrived"]);

/** Someone said they're coming (or is here). */
export function hasResponder(incident: Incident): boolean {
  return incident.alerts.some((a) => LIVE.has(a.state));
}

/** Volunteers coming to (or at) another open incident aren't alerted for a new one. */
function busyVolunteers(store: Store, exceptIncidentId: string): Set<string> {
  const busy = new Set<string>();
  for (const { incident } of store.listIncidents()) {
    if (incident.closed !== null || incident.incident_id === exceptIncidentId) continue;
    for (const a of incident.alerts) if (LIVE.has(a.state)) busy.add(a.volunteer_id);
  }
  return busy;
}

/** Who could still be alerted for this incident, best first. */
export function candidatesFor(store: Store, entry: IncidentEntry): Candidate[] {
  const box = store.getBox(entry.incident.box_id);
  if (!box) return [];
  const exclude = busyVolunteers(store, entry.incident.incident_id);
  for (const a of entry.incident.alerts) exclude.add(a.volunteer_id);
  return rankVolunteers(store.listVolunteers(), box.box.location, entry.incident.need, { exclude });
}

/** How many alerts the incident should have by now while nobody is coming: 3, then 6, then everyone matching. */
export function alertTarget(incident: Incident, now: Date): number {
  const elapsed = now.getTime() - Date.parse(incident.opened_at);
  if (elapsed >= ESCALATE_ALL_MS) return Number.POSITIVE_INFINITY;
  if (elapsed >= ESCALATE_NEXT_MS) return FIRST_WAVE + NEXT_WAVE;
  return FIRST_WAVE;
}

export type EscalationLevel = "first" | "next" | "all";

export interface EscalationView {
  level: EscalationLevel;
  /** For the dashboard: nobody coming after the last rung, or nobody to alert at all. */
  flag: "no_reply" | "nobody_matched" | null;
}

export function escalationOf(incident: Incident, now: Date): EscalationView {
  const target = alertTarget(incident, now);
  const level: EscalationLevel = target === FIRST_WAVE ? "first" : Number.isFinite(target) ? "next" : "all";
  if (incident.closed !== null || hasResponder(incident)) return { level, flag: null };
  if (incident.alerts.length === 0) return { level, flag: "nobody_matched" };
  return { level, flag: level === "all" ? "no_reply" : null };
}

/** Sends alerts up to the current target (nothing while someone is coming). Mutates `entry`; returns the pushes. */
function fillAlerts(ctx: AlertContext, entry: IncidentEntry, now: Date): Push[] {
  const { incident } = entry;
  if (incident.closed !== null || hasResponder(incident)) return [];
  const room = alertTarget(incident, now) - incident.alerts.length;
  if (room <= 0) return [];
  const at = now.toISOString();
  const fresh = candidatesFor(ctx.store, entry)
    .slice(0, Number.isFinite(room) ? room : undefined)
    .map(
      (c): Alert => ({
        alert_id: ctx.ids.id("alert"),
        incident_id: incident.incident_id,
        volunteer_id: c.volunteer.volunteer_id,
        volunteer_name: c.volunteer.name,
        state: "sent",
        eta_minutes: null,
        sent_at: at,
        updated_at: at,
      }),
    );
  incident.alerts.push(...fresh);
  return fresh.map((a) => alertUpdate(incident, a));
}

/**
 * A new incident: alert the first wave of volunteers. Stores the entry. Other boxes are not told: that waits for
 * the person at this box to ask (nearby.requested, see alertNearbyBoxes).
 */
export function startIncident(ctx: AlertContext, entry: IncidentEntry, now: Date): Push[] {
  const pushes = fillAlerts(ctx, entry, now);
  ctx.store.putIncident(entry);
  return pushes;
}

/** True once the person at the incident's box asked for nearby kits in this incident's session. */
export function nearbyRequested(ctx: AlertContext, entry: IncidentEntry): boolean {
  return ctx.store.eventsForBox(entry.incident.box_id).some((e) => e.event.type === "nearby.requested" && e.event.session_id === entry.incident.session_id);
}

/** The person at the box asked: every box within NEARBY_BOX_KM not told yet gets "Emergency at ..., bring this kit". */
export function alertNearbyBoxes(ctx: AlertContext, entry: IncidentEntry): Push[] {
  const box = ctx.store.getBox(entry.incident.box_id);
  const pushes: Push[] = [];
  if (box) {
    for (const other of ctx.store.listBoxes()) {
      if (other.box.box_id === box.box.box_id || entry.nearby_box_ids.includes(other.box.box_id) || haversineKm(other.box.location, box.box.location) > NEARBY_BOX_KM) continue;
      entry.nearby_box_ids.push(other.box.box_id);
      pushes.push(
        push(other.box.box_id, {
          type: "nearby.emergency",
          incident_id: entry.incident.incident_id,
          from_box_id: box.box.box_id,
          from_box_name: box.box.name,
          directions: box.box.directions,
        }),
      );
    }
  }
  ctx.store.putIncident(entry);
  return pushes;
}

/**
 * Closes an open incident; the first close wins (a closed one is left alone and returns no pushes). Unanswered
 * and coming alerts end `cancelled` (or `expired` on expiry); arrived and declined stay as they are.
 */
export function closeIncident(ctx: AlertContext, entry: IncidentEntry, how: NonNullable<Incident["closed"]>["how"], now: Date): Push[] {
  const { incident } = entry;
  if (incident.closed !== null) return [];
  const at = now.toISOString();
  incident.closed = { how, at };
  const pushes: Push[] = [];
  for (const a of incident.alerts) {
    if (a.state === "sent" || a.state === "shown" || a.state === "coming") {
      a.state = how === "expired" ? "expired" : "cancelled";
      a.updated_at = at;
      pushes.push(alertUpdate(incident, a));
    }
  }
  for (const boxId of entry.nearby_box_ids) pushes.push(push(boxId, { type: "nearby.clear", incident_id: incident.incident_id }));
  ctx.store.putIncident(entry);
  return pushes;
}

/** How a box closing ends its incident: `arrived` if a volunteer got there, else `cancelled`. */
export function closeHowForBoxClosed(incident: Incident): "arrived" | "cancelled" {
  return incident.alerts.some((a) => a.state === "arrived") ? "arrived" : "cancelled";
}

export type RespondResult =
  /** `answered`: the state changed. `unchanged`: a repeated tap, harmless. */
  | { outcome: "answered" | "unchanged"; incident: Incident; alert: Alert; pushes: Push[] }
  | { outcome: "not_found" }
  /** Only the volunteer the alert went to may answer it. */
  | { outcome: "not_yours" }
  /** The incident closed first (late answer), with the incident as it stands. */
  | { outcome: "closed"; incident: Incident; alert: Alert }
  /** A transition that makes no sense, e.g. "declined" after "arrived". */
  | { outcome: "invalid"; incident: Incident; alert: Alert };

type Action = AlertResponse["action"];
type Step = Alert["state"] | "same" | "invalid";

/** Next state for each (state, action). `same` is a harmless repeat. */
const TRANSITIONS: Record<"sent" | "shown" | "coming" | "declined" | "arrived", Record<Action, Step>> = {
  sent: { shown: "shown", coming: "coming", declined: "declined", arrived: "arrived" },
  shown: { shown: "same", coming: "coming", declined: "declined", arrived: "arrived" },
  coming: { shown: "same", coming: "same", declined: "declined", arrived: "arrived" },
  declined: { shown: "same", coming: "coming", declined: "same", arrived: "arrived" },
  arrived: { shown: "same", coming: "same", declined: "invalid", arrived: "same" },
};

/**
 * A volunteer's answer. `coming` and `arrived` only ever come from here, from the volunteer the alert went to,
 * so the box's comingLine can't name anyone who didn't accept. Declining after coming is allowed (they backed
 * out) and re-opens escalation on the next tick.
 */
export function respond(ctx: AlertContext, req: { alert_id: string; volunteer_id: string; action: Action }, now: Date): RespondResult {
  const entry = ctx.store.incidentByAlert(req.alert_id);
  if (!entry) return { outcome: "not_found" };
  const { incident } = entry;
  const alert = incident.alerts.find((a) => a.alert_id === req.alert_id)!;
  if (alert.volunteer_id !== req.volunteer_id) return { outcome: "not_yours" };
  if (incident.closed !== null || alert.state === "expired" || alert.state === "cancelled") return { outcome: "closed", incident, alert };
  const next = TRANSITIONS[alert.state][req.action];
  if (next === "invalid") return { outcome: "invalid", incident, alert };
  if (next === "same") return { outcome: "unchanged", incident, alert, pushes: [] };
  alert.state = next;
  alert.updated_at = now.toISOString();
  if (next === "coming") {
    const volunteer = ctx.store.getVolunteer(alert.volunteer_id);
    const box = ctx.store.getBox(incident.box_id);
    alert.eta_minutes = volunteer && box ? Math.min(600, estimateEta(haversineKm(volunteer.location, box.box.location), volunteer.vehicle_seats).minutes) : null;
  }
  ctx.store.putIncident(entry);
  return { outcome: "answered", incident, alert, pushes: [alertUpdate(incident, alert)] };
}

/** The companion app's inbox: this volunteer's alerts on open incidents. Fetching marks `sent` ones `shown` (Sophi's shown_to). */
export function inbox(ctx: AlertContext, volunteerId: string, now: Date): { alerts: { incident: Incident; alert: Alert }[]; pushes: Push[] } {
  const out: { incident: Incident; alert: Alert }[] = [];
  const pushes: Push[] = [];
  for (const entry of ctx.store.listIncidents()) {
    if (entry.incident.closed !== null) continue;
    const alert = entry.incident.alerts.find((a) => a.volunteer_id === volunteerId);
    if (!alert) continue;
    if (alert.state === "sent") {
      alert.state = "shown";
      alert.updated_at = now.toISOString();
      ctx.store.putIncident(entry);
      pushes.push(alertUpdate(entry.incident, alert));
    }
    out.push({ incident: entry.incident, alert });
  }
  return { alerts: out, pushes };
}

/** Drives escalation and expiry for every open incident. No timers: the caller decides when to tick. */
export function tickIncidents(ctx: AlertContext, now: Date): Push[] {
  const pushes: Push[] = [];
  for (const entry of ctx.store.listIncidents()) {
    if (entry.incident.closed !== null) continue;
    if (now.getTime() - Date.parse(entry.incident.opened_at) >= INCIDENT_OPEN_MAX_MS) {
      pushes.push(...closeIncident(ctx, entry, "expired", now));
      continue;
    }
    const sent = fillAlerts(ctx, entry, now);
    if (sent.length > 0) {
      ctx.store.putIncident(entry);
      pushes.push(...sent);
    }
  }
  return pushes;
}

/** The only sentence the box may say about who is coming, for its open incident (null when nobody accepted). */
export function comingLineForBox(store: Store, boxId: string): string | null {
  const entry = store.openIncidentForBox(boxId);
  return entry ? comingLine(entry.incident.alerts) : null;
}

/** Why one volunteer id couldn't be alerted by `alertVolunteers`. */
export type AlertRefusal = "not_a_candidate" | "already_alerted" | "duplicate";

export type AlertVolunteersResult =
  | { outcome: "alerted"; incident: Incident; alerted: Alert[]; refused: { volunteer_id: string; why: AlertRefusal }[]; pushes: Push[] }
  | { outcome: "not_found" }
  | { outcome: "closed"; incident: Incident };

/**
 * Alerts named volunteers now, beside the automatic waves (used by the response coordinator). Only current
 * candidates count (available, skilled for the need, in range, not busy elsewhere, not alerted yet); anyone else
 * is refused with a reason. The new alerts start `sent`, exactly like wave alerts, and count toward the wave
 * targets. Nothing else about the incident changes; `coming` still only comes from the volunteer.
 */
export function alertVolunteers(ctx: AlertContext, incidentId: string, volunteerIds: readonly string[], now: Date): AlertVolunteersResult {
  const entry = ctx.store.getIncident(incidentId);
  if (!entry) return { outcome: "not_found" };
  const { incident } = entry;
  if (incident.closed !== null) return { outcome: "closed", incident };
  const candidates = new Map(candidatesFor(ctx.store, entry).map((c) => [c.volunteer.volunteer_id, c]));
  const alertedIds = new Set(incident.alerts.map((a) => a.volunteer_id));
  const seen = new Set<string>();
  const refused: { volunteer_id: string; why: AlertRefusal }[] = [];
  const fresh: Alert[] = [];
  const at = now.toISOString();
  for (const id of volunteerIds) {
    if (seen.has(id)) {
      refused.push({ volunteer_id: id, why: "duplicate" });
      continue;
    }
    seen.add(id);
    if (alertedIds.has(id)) {
      refused.push({ volunteer_id: id, why: "already_alerted" });
      continue;
    }
    const c = candidates.get(id);
    if (!c) {
      refused.push({ volunteer_id: id, why: "not_a_candidate" });
      continue;
    }
    fresh.push({
      alert_id: ctx.ids.id("alert"),
      incident_id: incident.incident_id,
      volunteer_id: id,
      volunteer_name: c.volunteer.name,
      state: "sent",
      eta_minutes: null,
      sent_at: at,
      updated_at: at,
    });
  }
  if (fresh.length > 0) {
    incident.alerts.push(...fresh);
    ctx.store.putIncident(entry);
  }
  return { outcome: "alerted", incident, alerted: fresh, refused, pushes: fresh.map((a) => alertUpdate(incident, a)) };
}

export type RequestKitResult =
  | { outcome: "requested"; push: Push; already_told: boolean }
  | { outcome: "not_found" | "unknown_box" | "own_box" }
  | { outcome: "closed" }
  /** The person at the incident's box hasn't asked for other kits; nobody else may send for them. */
  | { outcome: "not_requested" };

/**
 * Tells one other box about an open incident ("Emergency at ..., bring this kit") with the same nearby.emergency
 * push alertNearbyBoxes sends, and remembers it so the box gets nearby.clear on close. Only after the person at
 * the incident's box asked for nearby kits. Distance and status limits are the caller's policy.
 */
export function requestKit(ctx: AlertContext, incidentId: string, boxId: string): RequestKitResult {
  const entry = ctx.store.getIncident(incidentId);
  if (!entry) return { outcome: "not_found" };
  if (entry.incident.closed !== null) return { outcome: "closed" };
  if (!nearbyRequested(ctx, entry)) return { outcome: "not_requested" };
  if (boxId === entry.incident.box_id) return { outcome: "own_box" };
  const from = ctx.store.getBox(entry.incident.box_id);
  const target = ctx.store.getBox(boxId);
  if (!from || !target) return { outcome: "unknown_box" };
  const already_told = entry.nearby_box_ids.includes(boxId);
  if (!already_told) {
    entry.nearby_box_ids.push(boxId);
    ctx.store.putIncident(entry);
  }
  return {
    outcome: "requested",
    already_told,
    push: push(boxId, {
      type: "nearby.emergency",
      incident_id: entry.incident.incident_id,
      from_box_id: from.box.box_id,
      from_box_name: from.box.name,
      directions: from.box.directions,
    }),
  };
}

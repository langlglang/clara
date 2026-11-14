import { haversineKm, type Network } from "@clara/network";
import type { AgentName, CoordinatorLog, RideProposal, RidesAdapter, ToolCallEntry } from "./types.js";

/**
 * The coordinator's tool layer. Every limit is enforced here, in code, whatever the planner (deep agent or rules)
 * asks for: a refused call returns `{ ok: false, error }` and changes nothing. Tool results are data for the
 * planner, never instructions.
 *
 * The layer has no way to talk to the bystander, the box voice, or volunteers (beyond the existing alert), and no
 * way to close an incident, mark anyone coming or arrived, approve a ride, or contact emergency services.
 */

export const LIMITS = {
  /** Volunteers per alert_volunteers call. */
  ALERTS_PER_CALL: 3,
  /** Alerts the coordinator may add per incident, beyond the automatic waves. */
  EXTRA_ALERTS_PER_INCIDENT: 6,
  /** request_kit only reaches boxes this close to the incident's box. */
  KIT_RADIUS_KM: 1.5,
  NOTE_MAX_CHARS: 400,
  REASON_MAX_CHARS: 200,
  /** Ride proposals per incident (each still needs a dispatcher). */
  RIDE_PROPOSALS_PER_INCIDENT: 2,
  NOTES_PER_INCIDENT: 20,
  FLAGS_PER_INCIDENT: 5,
} as const;

export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

/** Mutable per-incident state the tool layer reads and appends to (owned by the coordinator). */
export interface IncidentState {
  log: CoordinatorLog;
  kitRequests: Set<string>;
  rideProposals: RideProposal[];
}

export interface ToolContext {
  network: Network;
  rides?: RidesAdapter;
  incidentId: string;
  state: IncidentState;
  run: number;
  signal?: AbortSignal;
  clock: () => Date;
  /** Called after every recorded call so listeners see the log grow. */
  changed(): void;
}

const MAX_ACTIONS = 200;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const km = (n: number) => Math.round(n * 100) / 100;

function summarize(value: unknown, max = 160): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return "";
  }
}

export const READ_TOOLS = ["get_incident", "list_candidates", "get_nearby_kits", "get_rides", "get_site_overview"] as const;
export const ACT_TOOLS = ["alert_volunteers", "request_kit", "propose_ride", "post_dispatch_note", "flag_for_dispatcher"] as const;
export type ToolName = (typeof READ_TOOLS)[number] | (typeof ACT_TOOLS)[number];

export interface ToolLayer {
  get_incident(agent?: AgentName): ToolResult;
  list_candidates(agent?: AgentName): ToolResult;
  get_nearby_kits(agent?: AgentName): ToolResult;
  get_rides(agent?: AgentName): ToolResult;
  get_site_overview(agent?: AgentName): ToolResult;
  alert_volunteers(args: { volunteer_ids: string[]; reason: string }, agent?: AgentName): ToolResult;
  request_kit(args: { from_box_id: string; reason: string }, agent?: AgentName): ToolResult;
  propose_ride(args: { driver_id: string; reason: string }, agent?: AgentName): ToolResult;
  post_dispatch_note(args: { text: string }, agent?: AgentName): ToolResult;
  flag_for_dispatcher(args: { reason: string }, agent?: AgentName): ToolResult;
}

export function createToolLayer(ctx: ToolContext): ToolLayer {
  const { network, incidentId, state } = ctx;
  const now = () => ctx.clock();

  function record(agent: AgentName, tool: ToolName, kind: "read" | "act", args: string, result: ToolResult, reason: string | null, summary: string) {
    const entry: ToolCallEntry = { at: now().toISOString(), run: ctx.run, agent, tool, kind, args, ok: result.ok, result: summary, reason };
    state.log.actions.push(entry);
    if (state.log.actions.length > MAX_ACTIONS) state.log.actions.splice(0, state.log.actions.length - MAX_ACTIONS);
    state.log.updated_at = entry.at;
    ctx.changed();
  }

  /** Runs one tool call: refuses after the deadline, never throws, records the outcome. */
  function exec(agent: AgentName, tool: ToolName, kind: "read" | "act", args: string, reason: string | null, fn: () => { result: ToolResult; summary?: string }): ToolResult {
    let out: { result: ToolResult; summary?: string };
    if (ctx.signal?.aborted) out = { result: { ok: false, error: "The run's deadline passed; nothing was done." } };
    else {
      try {
        out = fn();
      } catch (error) {
        out = { result: { ok: false, error: `Tool failed: ${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    const summary = out.summary ?? (out.result.ok ? "ok" : out.result.error);
    record(agent, tool, kind, args, out.result, reason, clip(summary, 200));
    return out.result;
  }

  const fail = (error: string) => ({ result: { ok: false as const, error } });
  const openView = () => {
    const v = network.incident(incidentId);
    if (!v) return { error: "No such incident." } as const;
    if (v.incident.closed) return { error: `The incident is closed (${v.incident.closed.how}); nothing more to do.` } as const;
    return { view: v } as const;
  };
  const cleanReason = (reason: unknown) => (typeof reason === "string" ? clip(reason.trim(), LIMITS.REASON_MAX_CHARS) : "");

  return {
    get_incident(agent = "coordinator") {
      return exec(agent, "get_incident", "read", "", null, () => {
        const v = network.incident(incidentId);
        if (!v) return fail("No such incident.");
        const t = now().getTime();
        const report = network.report(incidentId);
        const alerts = v.incident.alerts.map((a) => ({
          volunteer_id: a.volunteer_id,
          name: a.volunteer_name,
          state: a.state,
          eta_minutes: a.eta_minutes,
          seconds_since_sent: Math.max(0, Math.round((t - Date.parse(a.sent_at)) / 1000)),
          seconds_since_update: Math.max(0, Math.round((t - Date.parse(a.updated_at)) / 1000)),
        }));
        const result: ToolResult = {
          ok: true,
          incident_id: v.incident.incident_id,
          need: v.incident.need,
          open: v.incident.closed === null,
          closed: v.incident.closed,
          minutes_open: Math.max(0, Math.round((t - Date.parse(v.incident.opened_at)) / 6000) / 10),
          box: v.box ? { box_id: v.box.box_id, name: v.box.name, directions: v.box.directions, status: v.box.status } : null,
          escalation: v.escalation,
          said_at_box: v.coming_line,
          alerts,
          extra_alerts_used: state.log.extra_alerts,
          extra_alerts_left: Math.max(0, LIMITS.EXTRA_ALERTS_PER_INCIDENT - state.log.extra_alerts),
          timeline: (report?.timeline ?? []).slice(-15).map((l) => ({ at: l.at, label: l.label, text: clip(l.text, 160) })),
          summary: report
            ? {
                mechanism: report.mist.mechanism.map((l) => clip(l.text, 120)),
                injuries: report.mist.injuries.map((l) => clip(l.text, 120)),
                signs: report.mist.signs.map((l) => clip(l.text, 120)),
                treatment: report.mist.treatment.map((l) => clip(l.text, 120)),
                tourniquet: report.tourniquet ? clip(report.tourniquet.text, 120) : null,
              }
            : null,
        };
        const counts = alerts.reduce<Record<string, number>>((m, a) => ((m[a.state] = (m[a.state] ?? 0) + 1), m), {});
        return { result, summary: `${v.incident.need}, ${v.escalation.level} wave, ${alerts.length} alerted (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"})` };
      });
    },

    list_candidates(agent = "coordinator") {
      return exec(agent, "list_candidates", "read", "", null, () => {
        const v = network.incident(incidentId);
        if (!v) return fail("No such incident.");
        const candidates = network.candidates(incidentId).slice(0, 12);
        const result: ToolResult = {
          ok: true,
          note: "Ranked best first. Only these volunteer_ids can be alerted; people already alerted, unavailable, busy elsewhere or without a matching skill are not listed.",
          candidates: candidates.map((c, i) => ({
            rank: i + 1,
            volunteer_id: c.volunteer.volunteer_id,
            name: c.volunteer.name,
            skills: c.volunteer.skills,
            matching_skills: c.matching_skills,
            languages: c.volunteer.languages,
            distance_km: km(c.distance_km),
            eta_minutes: c.eta.minutes,
            travel: c.eta.mode,
            vehicle_seats: c.volunteer.vehicle_seats,
            available: c.volunteer.available,
            already_alerted: false,
          })),
          already_alerted: v.incident.alerts.map((a) => ({ volunteer_id: a.volunteer_id, name: a.volunteer_name, state: a.state })),
        };
        return { result, summary: candidates.length ? `${candidates.length} candidates: ${candidates.slice(0, 4).map((c) => `${c.volunteer.name} ${km(c.distance_km)} km`).join(", ")}` : "no candidates left" };
      });
    },

    get_nearby_kits(agent = "coordinator") {
      return exec(agent, "get_nearby_kits", "read", "", null, () => {
        const v = network.incident(incidentId);
        if (!v || !v.box) return fail("No such incident or box.");
        const origin = v.box.location;
        const kits = network
          .kitMap()
          .filter((p) => p.box_id !== v.box!.box_id)
          .map((p) => {
            const supplies = network.supplies(p.box_id);
            const distance = haversineKm(origin, p.location);
            return {
              box_id: p.box_id,
              name: p.name,
              status: p.status,
              distance_km: km(distance),
              within_request_radius: distance <= LIMITS.KIT_RADIUS_KM,
              requestable: distance <= LIMITS.KIT_RADIUS_KM && p.status !== "offline" && !state.kitRequests.has(p.box_id),
              already_requested: state.kitRequests.has(p.box_id),
              last_updated_seconds_ago: p.last_updated_seconds_ago,
              battery_pct: p.battery_pct,
              low_items: supplies?.low_skus ?? [],
              stock: supplies ? Object.fromEntries(supplies.items.map((i) => [i.sku, i.remaining])) : {},
            };
          })
          .sort((a, b) => a.distance_km - b.distance_km);
        const own = network.supplies(v.box.box_id);
        const result: ToolResult = {
          ok: true,
          incident_box: { box_id: v.box.box_id, name: v.box.name, low_items: own?.low_skus ?? [], stock: own ? Object.fromEntries(own.items.map((i) => [i.sku, i.remaining])) : {} },
          kits,
        };
        return { result, summary: kits.map((k) => `${k.name} ${k.distance_km} km ${k.status}`).join(", ") || "no other kits" };
      });
    },

    get_rides(agent = "coordinator") {
      return exec(agent, "get_rides", "read", "", null, () => {
        if (!ctx.rides) return { result: { ok: true, available: false, note: "Ride planning isn't connected here." }, summary: "rides not connected" };
        const ride = ctx.rides.forIncident(incidentId);
        const result: ToolResult = {
          ok: true,
          available: true,
          note: "Drivers only get an offer when a dispatcher approves one. propose_ride suggests a driver to the dispatcher.",
          ride: ride
            ? {
                ride_id: ride.ride_id,
                state: ride.state,
                note: ride.note,
                offers: ride.offers,
                winner: ride.winner,
                suggested: ride.suggested,
                backups: ride.backups,
                hospital_minutes: ride.hospital_minutes,
              }
            : null,
          proposals: state.rideProposals,
        };
        return { result, summary: ride ? `ride ${ride.state}${ride.suggested ? `, suggested ${ride.suggested.name}` : ""}` : "no ride plan yet" };
      });
    },

    get_site_overview(agent = "coordinator") {
      return exec(agent, "get_site_overview", "read", "", null, () => {
        const incidents = network.incidents();
        const volunteers = network.store.listVolunteers();
        const busy = new Set<string>();
        for (const v of incidents) if (!v.incident.closed) for (const a of v.incident.alerts) if (a.state === "coming" || a.state === "arrived") busy.add(a.volunteer_id);
        const pins = network.kitMap();
        const result: ToolResult = {
          ok: true,
          open_incidents: incidents
            .filter((v) => !v.incident.closed)
            .map((v) => ({ incident_id: v.incident.incident_id, need: v.incident.need, box: v.box?.name ?? v.incident.box_id, escalation: v.escalation.level, coming: v.incident.alerts.filter((a) => a.state === "coming" || a.state === "arrived").length, this_one: v.incident.incident_id === incidentId })),
          volunteers: { total: volunteers.length, available: volunteers.filter((v) => v.available).length, busy_responding: busy.size, drivers_available: volunteers.filter((v) => v.available && v.vehicle_seats > 0).length },
          boxes: pins.map((p) => ({ box_id: p.box_id, name: p.name, status: p.status })),
        };
        const open = incidents.filter((v) => !v.incident.closed).length;
        return { result, summary: `${open} open incident(s), ${volunteers.filter((v) => v.available).length} available volunteers` };
      });
    },

    alert_volunteers(args, agent = "coordinator") {
      const ids = Array.isArray(args?.volunteer_ids) ? args.volunteer_ids.filter((x): x is string => typeof x === "string") : [];
      const reason = cleanReason(args?.reason);
      return exec(agent, "alert_volunteers", "act", ids.join(", "), reason || null, () => {
        const o = openView();
        if ("error" in o) return fail(o.error as string);
        if (!reason) return fail("Give a reason (it is shown to the dispatcher).");
        if (ids.length === 0) return fail("List at least one volunteer_id from list_candidates.");
        if (ids.length > LIMITS.ALERTS_PER_CALL) return fail(`At most ${LIMITS.ALERTS_PER_CALL} volunteers per call; you listed ${ids.length}.`);
        const left = LIMITS.EXTRA_ALERTS_PER_INCIDENT - state.log.extra_alerts;
        if (ids.length > left) return fail(`Only ${Math.max(0, left)} extra alert(s) left for this incident (limit ${LIMITS.EXTRA_ALERTS_PER_INCIDENT}).`);
        const candidates = new Set(network.candidates(incidentId).map((c) => c.volunteer.volunteer_id));
        const alerted = new Set(o.view.incident.alerts.map((a) => a.volunteer_id));
        const bad = ids.map((id) => (alerted.has(id) ? `${id} (already alerted)` : !candidates.has(id) ? `${id} (not a listed candidate)` : null)).filter(Boolean);
        if (bad.length) return fail(`Refused, nothing sent: ${bad.join(", ")}. Use ids from list_candidates.`);
        if (new Set(ids).size !== ids.length) return fail("The same volunteer is listed twice.");
        const r = network.alertVolunteers(incidentId, ids, reason);
        if (r.outcome !== "alerted") return fail(r.outcome === "closed" ? "The incident is closed." : "No such incident.");
        state.log.extra_alerts += r.alerted.length;
        const names = r.alerted.map((a) => a.volunteer_name);
        return {
          result: { ok: true, alerted: r.alerted.map((a) => ({ volunteer_id: a.volunteer_id, name: a.volunteer_name, state: a.state })), refused: r.refused, extra_alerts_left: LIMITS.EXTRA_ALERTS_PER_INCIDENT - state.log.extra_alerts },
          summary: `Alerted ${names.join(", ") || "nobody"}`,
        };
      });
    },

    request_kit(args, agent = "coordinator") {
      const boxId = typeof args?.from_box_id === "string" ? args.from_box_id : "";
      const reason = cleanReason(args?.reason);
      return exec(agent, "request_kit", "act", boxId, reason || null, () => {
        const o = openView();
        if ("error" in o) return fail(o.error as string);
        if (!reason) return fail("Give a reason (it is shown to the dispatcher).");
        const own = o.view.box;
        if (!own) return fail("The incident's box is unknown.");
        if (boxId === own.box_id) return fail("That is the incident's own box.");
        const pin = network.kitMap().find((p) => p.box_id === boxId);
        if (!pin) return fail(`No box "${boxId}". Use a box_id from get_nearby_kits.`);
        if (pin.status === "offline") return fail(`${pin.name} is offline; it can't show the request.`);
        const distance = haversineKm(own.location, pin.location);
        if (distance > LIMITS.KIT_RADIUS_KM) return fail(`${pin.name} is ${km(distance)} km away; kits can only be requested within ${LIMITS.KIT_RADIUS_KM} km.`);
        if (state.kitRequests.has(boxId)) return fail(`${pin.name} was already asked for this incident.`);
        const r = network.requestKit(incidentId, boxId);
        if (r.outcome !== "requested") return fail(`Couldn't request it (${r.outcome}).`);
        state.kitRequests.add(boxId);
        return { result: { ok: true, box_id: boxId, name: pin.name, distance_km: km(distance), shown_on_box: `Emergency at ${own.name}, bring this kit.` }, summary: `Asked ${pin.name} (${km(distance)} km) to bring its kit` };
      });
    },

    propose_ride(args, agent = "coordinator") {
      const driverId = typeof args?.driver_id === "string" ? args.driver_id : "";
      const reason = cleanReason(args?.reason);
      return exec(agent, "propose_ride", "act", driverId || "(suggested driver)", reason || null, () => {
        const o = openView();
        if ("error" in o) return fail(o.error as string);
        if (!ctx.rides) return fail("Ride planning isn't connected here.");
        if (!reason) return fail("Give a reason (it is shown to the dispatcher).");
        if (state.rideProposals.length >= LIMITS.RIDE_PROPOSALS_PER_INCIDENT) return fail(`At most ${LIMITS.RIDE_PROPOSALS_PER_INCIDENT} ride proposals per incident; the dispatcher decides.`);
        const existing = ctx.rides.forIncident(incidentId);
        if (existing?.state === "accepted") return fail(`A driver (${existing.winner?.driver_name ?? "someone"}) already accepted the ride.`);
        const ride = existing && existing.state !== "cancelled" ? existing : ctx.rides.request(incidentId, null);
        if (!ride) return fail("Couldn't open a ride plan for this incident.");
        const options = [ride.suggested, ...ride.backups].filter((d): d is NonNullable<typeof d> => d !== null);
        const driver = driverId ? options.find((d) => d.driver_id === driverId) : ride.suggested;
        if (!driver) return fail(driverId ? `"${driverId}" isn't one of the ride plan's free drivers (${options.map((d) => d.driver_id).join(", ") || "none"}).` : "The ride plan has no suitable free driver.");
        if (!driver.suitable) return fail(`${driver.name} isn't suitable for a patient (${driver.reasons[0] ?? "vehicle"}).`);
        if (state.rideProposals.some((p) => p.driver_id === driver.driver_id)) return fail(`${driver.name} was already proposed.`);
        const proposal: RideProposal = { at: now().toISOString(), ride_id: ride.ride_id, driver_id: driver.driver_id, driver_name: driver.name, reason };
        state.rideProposals.push(proposal);
        return {
          result: { ok: true, ride_id: ride.ride_id, proposed: { driver_id: driver.driver_id, name: driver.name, pickup_minutes: driver.pickup_minutes }, status: "waiting_for_dispatcher", note: "Nothing was offered to the driver. A dispatcher must approve it on the console." },
          summary: `Proposed ${driver.name} (pickup ${driver.pickup_minutes} min) for the ride; waiting for a dispatcher`,
        };
      });
    },

    post_dispatch_note(args, agent = "coordinator") {
      const text = typeof args?.text === "string" ? args.text.trim() : "";
      return exec(agent, "post_dispatch_note", "act", summarize(text, 80), null, () => {
        if (!text) return fail("The note is empty.");
        if (text.length > LIMITS.NOTE_MAX_CHARS) return fail(`Notes are at most ${LIMITS.NOTE_MAX_CHARS} characters; this one is ${text.length}.`);
        if (state.log.notes.length >= LIMITS.NOTES_PER_INCIDENT) return fail("Note limit reached for this incident.");
        state.log.notes.push({ at: now().toISOString(), run: ctx.run, text });
        return { result: { ok: true, shown_to: "dispatch console only" }, summary: "Note posted to the dispatch console" };
      });
    },

    flag_for_dispatcher(args, agent = "coordinator") {
      const reason = cleanReason(args?.reason);
      return exec(agent, "flag_for_dispatcher", "act", "", reason || null, () => {
        if (!reason) return fail("Say why a human is needed.");
        if (state.log.flags.length >= LIMITS.FLAGS_PER_INCIDENT) return fail("Flag limit reached; the dispatcher has already been flagged.");
        if (state.log.flags.some((f) => f.reason === reason)) return fail("That flag is already raised.");
        state.log.flags.push({ at: now().toISOString(), run: ctx.run, reason });
        return { result: { ok: true, shown_to: "dispatch console (needs a human)" }, summary: "Raised a needs-a-human flag" };
      });
    },
  };
}

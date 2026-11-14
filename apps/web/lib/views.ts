import { SKILLS_FOR_NEED, estimateEta, radiusFor, haversineKm, incidentEvents, type Candidate, type EscalationView, type Eta, type KitPin, type MaintainerAlert, type MaintainerRow, type ReportLabel, type SceneReport } from "@clara/network";
import type { Alert, BoxRecord, Incident, LatLng, Volunteer } from "@clara/contracts";
import type { CoordinatorLog, CoordinatorMode } from "@clara/coordinator";
import type { BoxMessage, Runtime } from "./server";
import type { Hospital, RideView, VehicleKind } from "./rides";
import type { CallLogEntry } from "./calls";
import type { PersistenceStatus } from "./snapshot";

/**
 * The JSON the API routes answer with, built on the server from the network facade. Client pages import these
 * types only (no server code ships to the browser).
 */

/** An incident without its secret report token (for volunteers). */
export type PublicIncident = Omit<Incident, "report_token">;

export interface HandoffLine {
  text: string;
  label: ReportLabel;
  at: string;
}

/** Numbers for the stat tiles, each from a box event (or the network), never estimated by a model. */
export interface SceneStats {
  /** When the tourniquet went on (timer.started), or null. */
  tourniquet_at: string | null;
  /** The latest pulse reading (sensor.pulse, a device reading), or null. */
  pulse: { bpm: number | null; quality: "valid" | "suspect" | "unavailable"; at: string } | null;
  alerted: number;
  coming: number;
  arrived: number;
  /** Minutes until an ambulance can reach the site (a demo setting), or null when not known. */
  ambulance_eta_min: number | null;
}

export interface InboxItem {
  alert: Alert;
  incident: PublicIncident;
  box: BoxRecord | null;
  distance_km: number | null;
  eta: Eta | null;
  /** What happened so far, from the scene report (each line labeled reported / observed / done). */
  handoff: HandoffLine[];
  /** The live scene timeline, newest first. */
  timeline: HandoffLine[];
  /** The template line the box says (null until someone accepted). */
  coming_line: string | null;
  scene: SceneStats;
  /** Skills that qualify for this need, and whether this volunteer has one. */
  needs_skills: string[];
  you_match: boolean;
  messages: BoxMessage[];
}

/** A ride offer as one driver sees it. */
export interface RideOfferItem {
  ride: RideView;
  box: BoxRecord | null;
  my_offer: RideView["offers"][number] | null;
  pickup_minutes: number | null;
  ambulance_eta_min: number | null;
}

export interface HomeStats {
  /** Other available volunteers within 1 km of you. */
  helpers_nearby: number;
  /** Boxes within 1 km of you. */
  kits_nearby: number;
  vehicle: VehicleKind;
  /** The volunteer's own alert radius, or the network default. */
  alert_radius_km: number;
  /** Devices subscribed to push alerts. */
  push_devices: number;
  /** Whether phone-call fallback can really dial (Twilio configured). */
  calls_configured: boolean;
  last_response: { box_name: string; at: string; state: string; how: string | null } | null;
}

export interface InboxResponse {
  volunteer: Volunteer;
  items: InboxItem[];
  rides: RideOfferItem[];
  home: HomeStats;
}

export interface IncidentDetail {
  incident: Incident;
  box: BoxRecord | null;
  coming_line: string | null;
  escalation: EscalationView;
  report: SceneReport | null;
  /** Who could still be alerted, best first (ids, names, distance, ETA). */
  candidates: { volunteer_id: string; name: string; distance_km: number; eta: Eta; matching_skills: string[] }[];
  ride: RideView | null;
  messages: BoxMessage[];
  scene: SceneStats;
  coordinator: CoordinatorView;
}

/** The response coordinator for one incident: its mode and its log (null before its first trigger). */
export interface CoordinatorView {
  mode: CoordinatorMode;
  label: string;
  model: string | null;
  log: CoordinatorLog | null;
}

export function coordinatorView(rt: Runtime, incidentId: string): CoordinatorView {
  const c = rt.coordinator;
  return { mode: c.mode, label: c.label, model: c.model, log: c.getLog(incidentId) ?? null };
}

export interface StateSnapshot {
  site: { name: string; center: LatLng };
  boxes: KitPin[];
  volunteers: Volunteer[];
  incidents: { incident: Incident; box: BoxRecord | null; coming_line: string | null; escalation: EscalationView; scene: SceneStats }[];
  rides: RideView[];
  vehicles: Record<string, VehicleKind>;
  hospital: Hospital;
  ambulance_eta_min: number | null;
  /** Whether state is saved to Postgres (also the health check's answer to "will this survive a restart?"). */
  persistence: PersistenceStatus;
  server_time: string;
}

export interface MaintainerResponse {
  rows: MaintainerRow[];
  /** Push and phone-call fallback status for the console. */
  outreach: { push_vapid: "env" | "generated" | "saved"; push_devices: number; calls_configured: boolean; calls: CallLogEntry[] };
  alerts: MaintainerAlert[];
  simulated_boxes: string[];
  server_time: string;
}

export interface KitMapResponse {
  site: { name: string; center: LatLng };
  pins: KitPin[];
  /** Available helpers, positions rounded to about 100 m, no names. */
  helpers: { at: LatLng; driver: boolean }[];
  /** Open emergencies: where and what is needed. */
  emergencies: { incident_id: string; box_id: string; box_name: string; at: LatLng; need: string; opened_at: string }[];
  server_time: string;
}

const publicIncident = ({ report_token: _t, ...rest }: Incident): PublicIncident => rest;

export function safeReport(rt: Runtime, incidentId: string): SceneReport | null {
  try {
    return rt.network.report(incidentId, rt.reportOptions) ?? null;
  } catch (error) {
    console.error("[report] failed its check:", error);
    return null;
  }
}

const line = (l: { text: string; label: ReportLabel; at: string }): HandoffLine => ({ text: l.text, label: l.label, at: l.at });

export function handoffOf(report: SceneReport | null): HandoffLine[] {
  if (!report) return [];
  return [
    ...report.mist.mechanism,
    ...report.mist.injuries,
    ...(report.tourniquet ? [report.tourniquet] : []),
    ...report.mist.signs.slice(-1),
    ...report.mist.treatment.filter((l) => !l.text.startsWith("Tourniquet applied")).slice(-4),
  ].map(line);
}

export function sceneOf(rt: Runtime, incident: Incident): SceneStats {
  const entry = rt.network.store.getIncident(incident.incident_id);
  const events = entry ? incidentEvents(rt.network.store, entry) : [];
  const tq = events.find((e) => e.type === "timer.started" && e.timer === "tourniquet");
  const pulses = events.filter((e) => e.type === "sensor.pulse");
  const pulse = pulses[pulses.length - 1];
  return {
    tourniquet_at: tq?.occurred_at ?? null,
    pulse: pulse && pulse.type === "sensor.pulse" ? { bpm: pulse.bpm, quality: pulse.quality, at: pulse.occurred_at } : null,
    alerted: incident.alerts.length,
    coming: incident.alerts.filter((a) => a.state === "coming").length,
    arrived: incident.alerts.filter((a) => a.state === "arrived").length,
    ambulance_eta_min: rt.ambulanceEtaMin,
  };
}

const NEARBY_KM = 1;

function homeStats(rt: Runtime, volunteer: Volunteer): HomeStats {
  const helpers = rt.network.store.listVolunteers().filter((v) => v.available && v.volunteer_id !== volunteer.volunteer_id && haversineKm(v.location, volunteer.location) <= NEARBY_KM);
  const kits = rt.network.store.listBoxes().filter((b) => haversineKm(b.box.location, volunteer.location) <= NEARBY_KM);
  let last: HomeStats["last_response"] = null;
  for (const v of rt.network.incidents()) {
    // Only answers they gave: coming or arrived (a closed incident turns coming into cancelled, so arrived shows there).
    const a = v.incident.alerts.find((x) => x.volunteer_id === volunteer.volunteer_id && (x.state === "arrived" || x.state === "coming"));
    if (!a) continue;
    if (!last || Date.parse(a.updated_at) > Date.parse(last.at)) last = { box_name: v.box?.name ?? v.incident.box_id, at: a.updated_at, state: a.state, how: v.incident.closed?.how ?? null };
  }
  return {
    helpers_nearby: helpers.length,
    kits_nearby: kits.length,
    vehicle: rt.vehicles.get(volunteer.volunteer_id) ?? (volunteer.vehicle_seats > 0 ? "car" : "none"),
    alert_radius_km: radiusFor(volunteer),
    push_devices: rt.push.devices(volunteer.volunteer_id),
    calls_configured: rt.calls.configured,
    last_response: last,
  };
}

export function inboxFor(rt: Runtime, volunteerId: string): InboxResponse | null {
  const volunteer = rt.network.store.getVolunteer(volunteerId);
  if (!volunteer) return null;
  const items = rt.network.inbox(volunteerId).map(({ incident, alert, box }): InboxItem => {
    const distance_km = box ? haversineKm(volunteer.location, box.location) : null;
    const report = safeReport(rt, incident.incident_id);
    const needs = [...SKILLS_FOR_NEED[incident.need]];
    return {
      alert,
      incident: publicIncident(incident),
      box,
      distance_km,
      eta: distance_km === null ? null : estimateEta(distance_km, volunteer.vehicle_seats),
      handoff: handoffOf(report),
      timeline: (report?.timeline ?? []).map(line).reverse().slice(0, 10),
      coming_line: rt.network.comingLine(incident.box_id),
      scene: sceneOf(rt, incident),
      needs_skills: needs,
      you_match: volunteer.skills.some((s) => needs.includes(s)),
      messages: rt.messages.get(incident.incident_id) ?? [],
    };
  });
  rt.rides.markSeen(volunteerId);
  const rides = rt.rides.forDriver(volunteerId).map((ride): RideOfferItem => {
    const box = rt.network.store.getBox(ride.box_id)?.box ?? null;
    const my = [...ride.offers].reverse().find((f) => f.driver_id === volunteerId) ?? null;
    const km = box ? haversineKm(volunteer.location, box.location) : null;
    return {
      ride,
      box,
      my_offer: my,
      pickup_minutes: ride.winner?.driver_id === volunteerId ? ride.winner.pickup_minutes : km === null ? null : estimateEta(km, volunteer.vehicle_seats).minutes,
      ambulance_eta_min: rt.ambulanceEtaMin,
    };
  });
  return { volunteer, items, rides, home: homeStats(rt, volunteer) };
}

export function incidentDetail(rt: Runtime, incidentId: string): IncidentDetail | null {
  const view = rt.network.incident(incidentId);
  if (!view) return null;
  return {
    ...view,
    report: safeReport(rt, incidentId),
    candidates: rt.network.candidates(incidentId).map((c: Candidate) => ({
      volunteer_id: c.volunteer.volunteer_id,
      name: c.volunteer.name,
      distance_km: c.distance_km,
      eta: c.eta,
      matching_skills: c.matching_skills,
    })),
    ride: rt.rides.forIncident(incidentId) ?? null,
    messages: rt.messages.get(incidentId) ?? [],
    scene: sceneOf(rt, view.incident),
    coordinator: coordinatorView(rt, incidentId),
  };
}

export function stateSnapshot(rt: Runtime, site: { name: string; center: LatLng }): StateSnapshot {
  return {
    site,
    boxes: rt.network.kitMap(),
    volunteers: rt.network.store.listVolunteers(),
    incidents: rt.network.incidents().map((v) => ({ ...v, scene: sceneOf(rt, v.incident) })),
    rides: rt.rides.list(),
    vehicles: Object.fromEntries(rt.network.store.listVolunteers().map((v) => [v.volunteer_id, rt.vehicles.get(v.volunteer_id) ?? (v.vehicle_seats > 0 ? "car" : "none")])),
    hospital: rt.rides.hospital,
    ambulance_eta_min: rt.ambulanceEtaMin,
    persistence: { ...rt.persistence },
    server_time: rt.network.clock().toISOString(),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function kitMapOf(rt: Runtime, site: { name: string; center: LatLng }): KitMapResponse {
  return {
    site,
    pins: rt.network.kitMap(),
    helpers: rt.network.store
      .listVolunteers()
      .filter((v) => v.available)
      .map((v) => ({ at: { lat: round(v.location.lat), lng: round(v.location.lng) }, driver: v.vehicle_seats > 0 })),
    emergencies: rt.network
      .incidents()
      .filter((v) => v.incident.closed === null && v.box)
      .map((v) => ({ incident_id: v.incident.incident_id, box_id: v.incident.box_id, box_name: v.box!.name, at: v.box!.location, need: v.incident.need, opened_at: v.incident.opened_at })),
    server_time: rt.network.clock().toISOString(),
  };
}

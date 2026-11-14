import type { BoxPush, LatLng, Volunteer } from "@clara/contracts";
import { DRIVE_KMH, MATCH_RADIUS_KM, estimateEta, haversineKm, type Ids, type Network } from "@clara/network";

/**
 * Volunteer driver rides to hospital (web-side module until packages/network grows ride operations).
 *
 * The dispatcher asks for a ride for an incident; the console suggests a driver (with reasons) and backups; the
 * dispatcher approves an offer to one driver (or several); the first driver to accept wins and every other open
 * offer becomes `lost`; an offer not answered within RIDE_OFFER_MS expires. Only a real accept names a driver at the
 * box (a templated `responder.message`); nothing promises a ride before that.
 */

export const RIDE_OFFER_MS = 60_000;
export type VehicleKind = "car" | "van" | "motorbike" | "none";
export const VEHICLE_KINDS: readonly VehicleKind[] = ["car", "van", "motorbike", "none"];

export interface Hospital {
  name: string;
  location: LatLng;
}
/** Fictional, like the rest of the demo site. */
export const DEMO_HOSPITAL: Hospital = { name: "District Hospital (fictional)", location: { lat: 40.395, lng: -74.62 } };

export type OfferState = "offered" | "accepted" | "declined" | "expired" | "withdrawn" | "lost";

export interface RideOffer {
  driver_id: string;
  driver_name: string;
  state: OfferState;
  offered_at: string;
  expires_at: string;
  answered_at: string | null;
}

export interface Ride {
  ride_id: string;
  incident_id: string;
  box_id: string;
  /** What the dispatcher wrote about the patient, e.g. "1 adult, can sit up". */
  note: string | null;
  created_at: string;
  state: "planning" | "offered" | "accepted" | "cancelled";
  offers: RideOffer[];
  /** Drivers the dispatcher passed over with "Reassign". */
  skipped: string[];
  winner: { driver_id: string; driver_name: string; pickup_minutes: number } | null;
}

export interface DriverOption {
  driver_id: string;
  name: string;
  vehicle: VehicleKind;
  seats: number;
  distance_km: number;
  pickup_minutes: number;
  hospital_minutes: number;
  suitable: boolean;
  reasons: string[];
}

export interface RideView extends Ride {
  suggested: DriverOption | null;
  backups: DriverOption[];
  hospital: Hospital;
  hospital_minutes: number | null;
}

export type RideChange = { kind: "ride"; ride: Ride } | { kind: "push"; box_id: string; push: BoxPush };

export type AnswerOutcome = "accepted" | "declined" | "taken" | "expired" | "not_offered" | "not_found" | "closed";

export interface RideBookOptions {
  network: Network;
  ids: Ids;
  vehicleOf(volunteerId: string): VehicleKind;
  emit(change: RideChange): void;
  hospital?: Hospital;
}

const LIVE_ALERT = new Set(["coming", "arrived"]);
const MEDICAL = new Set(["nurse", "doctor", "emt", "midwife"]);
const SKILL_WORDS: Record<string, string> = { nurse: "nurse", doctor: "doctor", emt: "EMT", midwife: "midwife" };

export const minutesTo = (km: number) => Math.max(1, Math.ceil((km / DRIVE_KMH) * 60));

export function createRideBook(o: RideBookOptions) {
  const rides = new Map<string, Ride>();
  const hospital = o.hospital ?? DEMO_HOSPITAL;
  const now = () => o.network.clock();
  const copy = <T>(v: T): T => structuredClone(v);
  const changed = (ride: Ride) => o.emit({ kind: "ride", ride: copy(ride) });

  /** Drivers busy elsewhere: the winner of another open ride, or coming to another open incident. */
  function busyDrivers(exceptIncident: string): Set<string> {
    const busy = new Set<string>();
    for (const r of rides.values()) if (r.incident_id !== exceptIncident && r.state === "accepted" && r.winner && isOpen(r)) busy.add(r.winner.driver_id);
    for (const v of o.network.incidents()) {
      if (v.incident.closed || v.incident.incident_id === exceptIncident) continue;
      for (const a of v.incident.alerts) if (LIVE_ALERT.has(a.state)) busy.add(a.volunteer_id);
    }
    return busy;
  }

  const isOpen = (r: Ride) => o.network.incident(r.incident_id)?.incident.closed === null && r.state !== "cancelled";

  function options(ride: Ride): DriverOption[] {
    const box = o.network.store.getBox(ride.box_id)?.box;
    if (!box) return [];
    const incident = o.network.incident(ride.incident_id)?.incident;
    const busy = busyDrivers(ride.incident_id);
    const passed = new Set([...ride.skipped, ...ride.offers.filter((f) => f.state !== "offered").map((f) => f.driver_id)]);
    const hospitalMinutes = minutesTo(haversineKm(box.location, hospital.location));
    const list = o.network.store
      .listVolunteers()
      .filter((v: Volunteer) => v.available && v.vehicle_seats > 0 && !busy.has(v.volunteer_id) && !passed.has(v.volunteer_id))
      .map((v): DriverOption => {
        const distance_km = haversineKm(v.location, box.location);
        const vehicle = o.vehicleOf(v.volunteer_id);
        const onScene = incident?.alerts.some((a) => a.volunteer_id === v.volunteer_id && LIVE_ALERT.has(a.state)) ?? false;
        const reasons: string[] = [];
        if (onScene) reasons.push("already coming to this emergency");
        if (v.vehicle_seats >= 2) reasons.push(`${v.vehicle_seats} seats: room for a helper`);
        else reasons.push("1 seat: patient only");
        const med = v.skills.filter((s) => MEDICAL.has(s));
        if (med.length) reasons.push(`also a ${med.map((s) => SKILL_WORDS[s]).join(" / ")}`);
        const suitable = vehicle !== "motorbike" && vehicle !== "none";
        if (!suitable) reasons.unshift(vehicle === "motorbike" ? "motorbike: not suitable for a patient" : "no vehicle listed");
        return {
          driver_id: v.volunteer_id,
          name: v.name,
          vehicle,
          seats: v.vehicle_seats,
          distance_km,
          pickup_minutes: estimateEta(distance_km, v.vehicle_seats).minutes,
          hospital_minutes: hospitalMinutes,
          suitable,
          reasons,
        };
      })
      .filter((d) => d.distance_km <= MATCH_RADIUS_KM)
      .sort((a, b) => Number(b.suitable) - Number(a.suitable) || a.pickup_minutes - b.pickup_minutes || b.seats - a.seats || a.driver_id.localeCompare(b.driver_id));
    const first = list.find((d) => d.suitable);
    if (first) first.reasons.unshift(`closest free driver, pickup ${first.pickup_minutes} min`);
    return list;
  }

  function view(ride: Ride): RideView {
    const opts = ride.state === "accepted" || ride.state === "cancelled" ? [] : options(ride);
    const offered = new Set(ride.offers.filter((f) => f.state === "offered").map((f) => f.driver_id));
    const free = opts.filter((d) => !offered.has(d.driver_id));
    const suggested = free.find((d) => d.suitable) ?? null;
    const box = o.network.store.getBox(ride.box_id)?.box;
    return {
      ...copy(ride),
      suggested,
      backups: free.filter((d) => d !== suggested).slice(0, 4),
      hospital,
      hospital_minutes: box ? minutesTo(haversineKm(box.location, hospital.location)) : null,
    };
  }

  function offer(ride: Ride, driverId: string): RideOffer | null {
    const v = o.network.store.getVolunteer(driverId);
    if (!v || v.vehicle_seats === 0) return null;
    const at = now();
    const existing = ride.offers.find((f) => f.driver_id === driverId && f.state === "offered");
    if (existing) return existing;
    const f: RideOffer = {
      driver_id: driverId,
      driver_name: v.name,
      state: "offered",
      offered_at: at.toISOString(),
      expires_at: new Date(at.getTime() + RIDE_OFFER_MS).toISOString(),
      answered_at: null,
    };
    ride.offers.push(f);
    ride.state = "offered";
    return f;
  }

  return {
    hospital,
    /** One ride per open incident: asking again returns the open one. */
    request(incidentId: string, note: string | null): RideView | undefined {
      const incident = o.network.incident(incidentId)?.incident;
      if (!incident || incident.closed) return undefined;
      const open = [...rides.values()].find((r) => r.incident_id === incidentId && r.state !== "cancelled");
      if (open) return view(open);
      const ride: Ride = {
        ride_id: o.ids.id("ride"),
        incident_id: incidentId,
        box_id: incident.box_id,
        note: note?.trim().slice(0, 120) || null,
        created_at: now().toISOString(),
        state: "planning",
        offers: [],
        skipped: [],
        winner: null,
      };
      rides.set(ride.ride_id, ride);
      changed(ride);
      return view(ride);
    },
    /** The dispatcher approves an offer to `driverId` (default: the suggested driver). */
    approve(rideId: string, driverId?: string): { ok: true; ride: RideView } | { ok: false; error: "not_found" | "closed" | "no_driver" } {
      const ride = rides.get(rideId);
      if (!ride) return { ok: false, error: "not_found" };
      if (!isOpen(ride) || ride.state === "accepted") return { ok: false, error: "closed" };
      const target = driverId ?? view(ride).suggested?.driver_id;
      if (!target || !options(ride).some((d) => d.driver_id === target) || !offer(ride, target)) return { ok: false, error: "no_driver" };
      changed(ride);
      return { ok: true, ride: view(ride) };
    },
    /** Pass over the suggested driver (withdrawing open offers) so the next one is suggested. To pick a backup, approve them directly. */
    reassign(rideId: string): { ok: true; ride: RideView } | { ok: false; error: "not_found" | "closed" } {
      const ride = rides.get(rideId);
      if (!ride) return { ok: false, error: "not_found" };
      if (!isOpen(ride) || ride.state === "accepted") return { ok: false, error: "closed" };
      const current = view(ride).suggested;
      const at = now().toISOString();
      const open = ride.offers.filter((f) => f.state === "offered");
      for (const f of open) {
        f.state = "withdrawn";
        f.answered_at = at;
        ride.skipped.push(f.driver_id);
      }
      if (open.length === 0 && current) ride.skipped.push(current.driver_id);
      if (!ride.offers.some((f) => f.state === "offered")) ride.state = "planning";
      changed(ride);
      return { ok: true, ride: view(ride) };
    },
    /** A driver's answer. The first accept wins; other open offers become `lost`. */
    answer(rideId: string, driverId: string, action: "accept" | "decline"): { outcome: AnswerOutcome; ride?: RideView } {
      const ride = rides.get(rideId);
      if (!ride) return { outcome: "not_found" };
      const f = [...ride.offers].reverse().find((x) => x.driver_id === driverId);
      if (!f) return { outcome: "not_offered" };
      if (!isOpen(ride)) return { outcome: "closed", ride: view(ride) };
      if (ride.winner) return { outcome: ride.winner.driver_id === driverId ? "accepted" : "taken", ride: view(ride) };
      if (f.state !== "offered") return { outcome: f.state === "expired" ? "expired" : f.state === "declined" ? "declined" : "not_offered", ride: view(ride) };
      const at = now();
      if (at.getTime() >= Date.parse(f.expires_at)) {
        f.state = "expired";
        f.answered_at = at.toISOString();
        changed(ride);
        return { outcome: "expired", ride: view(ride) };
      }
      f.answered_at = at.toISOString();
      if (action === "decline") {
        f.state = "declined";
        if (!ride.offers.some((x) => x.state === "offered")) ride.state = "planning";
        changed(ride);
        return { outcome: "declined", ride: view(ride) };
      }
      f.state = "accepted";
      const pickup = options(ride).find((d) => d.driver_id === driverId)?.pickup_minutes ?? 0;
      ride.winner = { driver_id: driverId, driver_name: f.driver_name, pickup_minutes: pickup };
      ride.state = "accepted";
      for (const other of ride.offers) if (other !== f && other.state === "offered") Object.assign(other, { state: "lost", answered_at: at.toISOString() });
      changed(ride);
      // Template words, after a real accept only.
      o.emit({
        kind: "push",
        box_id: ride.box_id,
        push: {
          type: "responder.message",
          incident_id: ride.incident_id,
          from: "Clara dispatch",
          text: `${f.driver_name}, a volunteer driver, accepted the ride to hospital. Pickup in about ${Math.max(1, pickup)} minute${pickup === 1 ? "" : "s"}.`,
        },
      });
      return { outcome: "accepted", ride: view(ride) };
    },
    cancel(rideId: string): RideView | undefined {
      const ride = rides.get(rideId);
      if (!ride) return undefined;
      ride.state = "cancelled";
      const at = now().toISOString();
      for (const f of ride.offers) if (f.state === "offered") Object.assign(f, { state: "withdrawn", answered_at: at });
      changed(ride);
      return view(ride);
    },
    /** Expires unanswered offers; rides of closed incidents stop offering. */
    tick(at: Date = now()) {
      for (const ride of rides.values()) {
        let dirty = false;
        for (const f of ride.offers) {
          if (f.state === "offered" && (at.getTime() >= Date.parse(f.expires_at) || !isOpen(ride))) {
            f.state = isOpen(ride) ? "expired" : "withdrawn";
            f.answered_at = at.toISOString();
            dirty = true;
          }
        }
        if (dirty && ride.state === "offered" && !ride.offers.some((f) => f.state === "offered")) ride.state = "planning";
        if (dirty) changed(ride);
      }
    },
    get: (rideId: string) => (rides.has(rideId) ? view(rides.get(rideId)!) : undefined),
    forIncident(incidentId: string): RideView | undefined {
      const r = [...rides.values()].filter((x) => x.incident_id === incidentId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      return r ? view(r) : undefined;
    },
    list: (): RideView[] => [...rides.values()].map(view),
    /** Open offers to one driver, and rides they won on open incidents. */
    forDriver(driverId: string): RideView[] {
      return [...rides.values()].filter((r) => isOpen(r) && (r.winner?.driver_id === driverId || r.offers.some((f) => f.driver_id === driverId && (f.state === "offered" || f.state === "lost")))).map(view);
    },
  };
}

export type RideBook = ReturnType<typeof createRideBook>;

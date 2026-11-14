import type { Incident, LatLng, Skill, Volunteer } from "@clara/contracts";
import { DRIVE_KMH, DRIVE_MIN_KM, MATCH_RADIUS_KM, WALK_KMH } from "./config.js";

export type Need = Incident["need"];

/** Skills that qualify a volunteer for each need, most specific first. `driver` alone never qualifies. */
export const SKILLS_FOR_NEED: Record<Need, readonly Skill[]> = {
  bleeding: ["stop_the_bleed", "first_aid", "nurse", "doctor", "emt"],
  breathing: ["cpr", "nurse", "doctor", "emt"],
  general: ["stop_the_bleed", "cpr", "first_aid", "nurse", "doctor", "emt", "midwife"],
};

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Eta {
  mode: "walking" | "driving";
  /** Whole minutes, rounded up, from straight-line distance (an estimate, not a route). */
  minutes: number;
}

/** Walking at 5 km/h, or driving at 30 km/h for someone with a vehicle when it's farther than 1 km. */
export function estimateEta(distanceKm: number, vehicleSeats: number): Eta {
  const driving = vehicleSeats > 0 && distanceKm > DRIVE_MIN_KM;
  const kmh = driving ? DRIVE_KMH : WALK_KMH;
  return { mode: driving ? "driving" : "walking", minutes: Math.ceil((distanceKm / kmh) * 60) };
}

export interface Candidate {
  volunteer: Volunteer;
  distance_km: number;
  eta: Eta;
  /** The volunteer's skills that count for this need. */
  matching_skills: Skill[];
}

export interface RankOptions {
  /** Volunteer ids to leave out (already alerted, or busy with another incident). */
  exclude?: ReadonlySet<string>;
  /** The network's radius (default MATCH_RADIUS_KM). A volunteer's own `alert_radius_km` can only narrow it. */
  radiusKm?: number;
}

/** How far from a box this volunteer may be alerted: their own radius when set, never beyond the network's. */
export function radiusFor(volunteer: Volunteer, networkRadiusKm: number = MATCH_RADIUS_KM): number {
  const own = volunteer.alert_radius_km;
  return own === undefined ? networkRadiusKm : Math.min(own, networkRadiusKm);
}

/**
 * Available volunteers with a skill for the need, within the radius, fastest first (ETA, then distance, then
 * more matching skills, then id so the order is stable).
 */
export function rankVolunteers(volunteers: readonly Volunteer[], boxLocation: LatLng, need: Need, options: RankOptions = {}): Candidate[] {
  const wanted = SKILLS_FOR_NEED[need];
  const radius = options.radiusKm ?? MATCH_RADIUS_KM;
  return volunteers
    .filter((v) => v.available && !options.exclude?.has(v.volunteer_id))
    .map((v): Candidate => {
      const distance_km = haversineKm(v.location, boxLocation);
      return { volunteer: v, distance_km, eta: estimateEta(distance_km, v.vehicle_seats), matching_skills: v.skills.filter((s) => wanted.includes(s)) };
    })
    .filter((c) => c.matching_skills.length > 0 && c.distance_km <= radiusFor(c.volunteer, radius))
    .sort(
      (a, b) =>
        a.eta.minutes - b.eta.minutes ||
        a.distance_km - b.distance_km ||
        b.matching_skills.length - a.matching_skills.length ||
        a.volunteer.volunteer_id.localeCompare(b.volunteer.volunteer_id),
    );
}

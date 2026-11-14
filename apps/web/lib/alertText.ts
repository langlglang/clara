import type { Alert, QuietHours, Volunteer } from "@clara/contracts";
import { estimateEta, haversineKm, type Network } from "@clara/network";

/**
 * The words a push notification and a phone call use for one alert, built from network data only: the need,
 * the box's name and the volunteer's straight-line distance. No patient names, no promise that help is there.
 */

export const NEED_WORDS: Record<string, string> = { bleeding: "Severe bleeding", breathing: "Breathing / CPR", general: "First aid" };
const NEED_SPOKEN: Record<string, string> = { bleeding: "severe bleeding", breathing: "a breathing emergency, CPR may be needed", general: "someone who needs first aid" };

export interface AlertWords {
  alert_id: string;
  incident_id: string;
  volunteer_id: string;
  need: string;
  box_name: string;
  /** e.g. "300 m" or "1.4 km"; null when the box has no location. */
  distance: string | null;
  /** e.g. "about 300 meters" for speech. */
  distance_spoken: string | null;
  minutes: number | null;
  title: string;
  body: string;
  /** The sentence the phone call says before "Press 1". */
  spoken: string;
}

export const distanceText = (km: number) => (km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(1)} km`);
export const distanceSpoken = (km: number) => (km < 1 ? `about ${Math.max(10, Math.round((km * 1000) / 50) * 50)} meters` : `about ${km.toFixed(1)} kilometers`);

export function alertWords(network: Network, alert: Alert): AlertWords | null {
  const entry = network.store.getIncident(alert.incident_id);
  const volunteer = network.store.getVolunteer(alert.volunteer_id);
  if (!entry || !volunteer) return null;
  const box = network.store.getBox(entry.incident.box_id)?.box ?? null;
  const need = entry.incident.need;
  const boxName = box?.name ?? "a Clara box";
  const km = box ? haversineKm(volunteer.location, box.location) : null;
  const minutes = km === null ? null : estimateEta(km, volunteer.vehicle_seats).minutes;
  const distance = km === null ? null : distanceText(km);
  const where = distance === null ? boxName : `${boxName} · ${distance}${minutes !== null ? ` (about ${Math.max(1, minutes)} min)` : ""}`;
  const spokenDistance = km === null ? null : distanceSpoken(km);
  return {
    alert_id: alert.alert_id,
    incident_id: entry.incident.incident_id,
    volunteer_id: volunteer.volunteer_id,
    need,
    box_name: boxName,
    distance,
    distance_spoken: spokenDistance,
    minutes,
    title: "EMERGENCY NEARBY",
    body: `${NEED_WORDS[need] ?? "Emergency"} · ${where}. Can you come?`,
    spoken: `There is an emergency near you: ${NEED_SPOKEN[need] ?? "an emergency"} at ${boxName}${spokenDistance ? `, ${spokenDistance} away` : ""}.`,
  };
}

/** Minutes since midnight of `now` in `tz` (falls back to UTC for an unknown zone). */
function minutesIn(tz: string, now: Date): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Inside the volunteer's quiet hours now? A window like 22:00–07:00 wraps past midnight; start == end is off. */
export function inQuietHours(quiet: QuietHours | undefined, now: Date): boolean {
  if (!quiet) return false;
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  if (start === end) return false;
  const m = minutesIn(quiet.tz, now);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** E.164: a plus, a country code that doesn't start with 0, 7 to 15 digits in all. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/** "+1******4567": enough to tell numbers apart in logs, never the whole number. */
export const maskPhone = (phone: string) => (phone.length <= 6 ? "***" : `${phone.slice(0, 2)}${"*".repeat(Math.max(3, phone.length - 6))}${phone.slice(-4)}`);

/** May Clara phone this volunteer at all? A real E.164 number and their own yes. */
export const callable = (v: Volunteer): v is Volunteer & { phone: string } => v.call_consent === true && typeof v.phone === "string" && E164.test(v.phone);

export interface RideWords {
  ride_id: string;
  driver_id: string;
  incident_id: string;
  box_name: string;
  hospital: string;
  seats: number;
  /** Pickup distance from the driver, e.g. "1.4 km". */
  distance: string | null;
  title: string;
  body: string;
  spoken: string;
}

/** A ride offer in words (push and call): pickup box → hospital, seats, and how far the pickup is from the driver. */
export function rideWords(network: Network, ride: { ride_id: string; incident_id: string; box_id: string; seats_needed: number; hospital: { name: string } }, driverId: string): RideWords | null {
  const driver = network.store.getVolunteer(driverId);
  if (!driver) return null;
  const box = network.store.getBox(ride.box_id)?.box ?? null;
  const boxName = box?.name ?? "a Clara box";
  const km = box ? haversineKm(driver.location, box.location) : null;
  const seats = `${ride.seats_needed} seat${ride.seats_needed === 1 ? "" : "s"}`;
  const hospitalSpoken = ride.hospital.name.replace(/\s*\(fictional\)\s*/i, "");
  return {
    ride_id: ride.ride_id,
    driver_id: driverId,
    incident_id: ride.incident_id,
    box_name: boxName,
    hospital: ride.hospital.name,
    seats: ride.seats_needed,
    distance: km === null ? null : distanceText(km),
    title: "RIDE NEEDED",
    body: `${boxName} → ${ride.hospital.name} · ${seats}${km === null ? "" : ` · ${distanceText(km)} from you`}. Can you drive?`,
    spoken: `A patient needs a ride to hospital, from ${boxName} to ${hospitalSpoken}, ${seats}.${km === null ? "" : ` The pickup is ${distanceSpoken(km)} from you.`}`,
  };
}

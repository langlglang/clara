import type { Network } from "@clara/network";
import { alertWords, callable, inQuietHours, maskPhone, rideWords } from "./alertText";
import type { RideBook } from "./rides";
import { callTwiml, placeCall, type FetchLike, type TwilioConfig } from "./twilio";

/**
 * The phone-call fallback. An alert still `sent` (the app never showed it, nobody answered) CALL_AFTER_MS after it
 * went out gets ONE call, only when the volunteer gave an E.164 number and agreed to calls, isn't in quiet hours,
 * hasn't had MAX_CALLS_PER_HOUR calls already, and Twilio is configured. Without Twilio it logs "would call" with a
 * masked number. Ride offers get the same treatment: an offer still open and never shown in the driver's app
 * CALL_AFTER_MS after it went out gets one call ("press 1 to drive"), and the offer gets RIDE_CALL_EXTEND_MS more
 * time while the phone rings. Driven by the runtime's tick; starts no timers itself.
 */

export const CALL_AFTER_MS = 30_000;
export const MAX_CALLS_PER_HOUR = 3;
export const RIDE_CALL_EXTEND_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_LOG = 30;

export type CallStatus = "placed" | "failed" | "would_call" | "capped" | "quiet";

export interface CallLogEntry {
  /** The alert id, or the ride id for a ride call. */
  alert_id: string;
  kind: "alert" | "ride";
  volunteer_id: string;
  /** Masked, e.g. "+1******4567". */
  to: string;
  status: CallStatus;
  at: string;
  detail?: string;
}

export interface CallBook {
  readonly configured: boolean;
  /** Looks for alerts due a call. Returns the entries it logged this time. */
  tick(now?: Date): CallLogEntry[];
  recent(): CallLogEntry[];
  /** Resolves when every call started so far has finished (tests). */
  idle(): Promise<void>;
}

export interface CallBookOptions {
  network: Network;
  /** Ride offers to call drivers about (optional). */
  rides?: Pick<RideBook, "list" | "extendOffer">;
  twilio: TwilioConfig | null;
  /** Public origin for Twilio's callback (no trailing slash). */
  baseUrl: string;
  fetch?: FetchLike;
  log?: (line: string) => void;
  callAfterMs?: number;
  maxPerHour?: number;
}

export function createCallBook({ network, rides, twilio, baseUrl, fetch: fetchImpl = fetch, log = console.log, callAfterMs = CALL_AFTER_MS, maxPerHour = MAX_CALLS_PER_HOUR }: CallBookOptions): CallBook {
  /** Alerts and ride offers already handled (called, logged, capped or skipped): one decision each, ever. */
  const decided = new Set<string>();
  /** Call times per volunteer (placed or would-call), for the hourly cap. */
  const history = new Map<string, number[]>();
  const entries: CallLogEntry[] = [];
  const pending = new Set<Promise<unknown>>();

  const record = (e: CallLogEntry) => {
    entries.unshift(e);
    entries.length = Math.min(entries.length, MAX_LOG);
    return e;
  };

  interface Due {
    key: string;
    kind: "alert" | "ride";
    id: string;
    volunteerId: string;
    /** Words and callback query, built only once the gates pass. */
    build(): { spoken: string; query: string } | null;
    onPlaced?(): void;
  }

  /** The gates every call passes: consent and an E.164 number, quiet hours, the hourly cap, Twilio configured. */
  function consider(due: Due, now: Date, out: CallLogEntry[]) {
    if (decided.has(due.key)) return;
    decided.add(due.key);
    const volunteer = network.store.getVolunteer(due.volunteerId);
    // No number or no consent: never call, and never reconsider.
    if (!volunteer || !callable(volunteer)) return;
    const t = now.getTime();
    const base = { alert_id: due.id, kind: due.kind, volunteer_id: volunteer.volunteer_id, to: maskPhone(volunteer.phone), at: now.toISOString() };
    if (inQuietHours(volunteer.quiet_hours, now)) {
      out.push(record({ ...base, status: "quiet" }));
      return;
    }
    const recentCalls = (history.get(volunteer.volunteer_id) ?? []).filter((x) => t - x < HOUR_MS);
    history.set(volunteer.volunteer_id, recentCalls);
    if (recentCalls.length >= maxPerHour) {
      out.push(record({ ...base, status: "capped" }));
      log(`[calls] not calling ${base.to}: ${maxPerHour} calls in the last hour already.`);
      return;
    }
    const words = due.build();
    if (!words) return;
    recentCalls.push(t);
    if (!twilio) {
      out.push(record({ ...base, status: "would_call" }));
      log(`[calls] would call ${base.to} for ${due.kind} ${due.id} (Twilio not configured).`);
      return;
    }
    const entry = record({ ...base, status: "placed" });
    out.push(entry);
    due.onPlaced?.();
    const run = placeCall(twilio, volunteer.phone, callTwiml(words.spoken, `${baseUrl}/api/twilio/gather?${words.query}`, due.kind), fetchImpl).then(
      (sid) => log(`[calls] called ${base.to} for ${due.kind} ${due.id} (${sid}).`),
      (error: Error) => {
        entry.status = "failed";
        entry.detail = error.message.slice(0, 160);
        log(`[calls] call to ${base.to} failed: ${entry.detail}`);
      },
    );
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  return {
    configured: twilio !== null,
    tick(now = network.clock()) {
      const out: CallLogEntry[] = [];
      const t = now.getTime();
      for (const { incident } of network.store.listIncidents()) {
        if (incident.closed !== null) continue;
        for (const alert of incident.alerts) {
          if (alert.state !== "sent" || t - Date.parse(alert.sent_at) < callAfterMs) continue;
          consider(
            {
              key: `alert/${alert.alert_id}`,
              kind: "alert",
              id: alert.alert_id,
              volunteerId: alert.volunteer_id,
              build: () => {
                const w = alertWords(network, alert);
                return w && { spoken: w.spoken, query: new URLSearchParams({ alert: alert.alert_id, volunteer: alert.volunteer_id }).toString() };
              },
            },
            now,
            out,
          );
        }
      }
      for (const ride of rides?.list() ?? []) {
        if (ride.state !== "offered" || ride.winner) continue;
        if (network.store.getIncident(ride.incident_id)?.incident.closed !== null) continue;
        for (const f of ride.offers) {
          if (f.state !== "offered" || f.seen_at !== null || t - Date.parse(f.offered_at) < callAfterMs) continue;
          consider(
            {
              key: `ride/${ride.ride_id}/${f.driver_id}/${f.offered_at}`,
              kind: "ride",
              id: ride.ride_id,
              volunteerId: f.driver_id,
              build: () => {
                const w = rideWords(network, ride, f.driver_id);
                return w && { spoken: w.spoken, query: new URLSearchParams({ ride: ride.ride_id, driver: f.driver_id }).toString() };
              },
              onPlaced: () => rides?.extendOffer(ride.ride_id, f.driver_id, RIDE_CALL_EXTEND_MS),
            },
            now,
            out,
          );
        }
      }
      return out;
    },
    recent: () => entries.map((e) => ({ ...e })),
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

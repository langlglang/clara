import { randomBytes, randomUUID } from "node:crypto";

/** Timings and distances for the response network. All logic takes `now` explicitly; nothing here starts a timer. */

/** A box with no event for this long is offline. */
export const OFFLINE_AFTER_MS = 90_000;
/** Nobody coming this long after the incident opened: alert the next wave. */
export const ESCALATE_NEXT_MS = 60_000;
/** Nobody coming this long after: alert every matching volunteer, and the dashboard flags it. */
export const ESCALATE_ALL_MS = 120_000;
export const FIRST_WAVE = 3;
export const NEXT_WAVE = 3;
/** Other boxes within this distance light up with "Emergency at ..., bring this kit." */
export const NEARBY_BOX_KM = 1;
/** Volunteers farther than this from the box are never alerted. */
export const MATCH_RADIUS_KM = 10;
/** An incident still open after this closes `expired` (like Sophi's HELP_OPEN_MAX_MS). */
export const INCIDENT_OPEN_MAX_MS = 60 * 60_000;
export const WALK_KMH = 5;
export const DRIVE_KMH = 30;
/** Drivers walk anything shorter than this. */
export const DRIVE_MIN_KM = 1;
/** A manifest item is low when half or less of its stocked count remains (one of two tourniquets used is low). */
export const LOW_SUPPLY_FRACTION = 0.5;

/** The server's clock. Injected so tests (and the tick loop) control time. */
export type Clock = () => Date;

export interface Ids {
  /** A new id that matches the contracts' `Id` pattern, e.g. `alert_<uuid>`. */
  id(prefix: string): string;
  /** A secret token for the EMS report link (16–64 chars). */
  token(): string;
}

export const randomIds: Ids = {
  id: (prefix) => `${prefix}_${randomUUID()}`,
  token: () => randomBytes(16).toString("hex"),
};

/** Deterministic ids for tests and the seed. */
export function sequentialIds(): Ids {
  let n = 0;
  return {
    id: (prefix) => `${prefix}_${++n}`,
    token: () => `token${String(++n).padStart(16, "0")}`,
  };
}

import { CoordinatorSnapshotSchema, type CoordinatorSnapshot } from "@clara/coordinator";
import { StoreSnapshotSchema, type MaintainerAlert, type StoreSnapshot } from "@clara/network";
import type { CallBookSnapshot } from "./calls";
import type { PushSubscriptionJson } from "./push";
import { TRIP_STEPS, VEHICLE_KINDS, type Ride, type VehicleKind } from "./rides";
import type { BoxMessage } from "./server";

/**
 * The runtime's state as one versioned JSON document (what lib/persist.ts writes to Postgres). The network store and
 * the coordinator check their own parts with zod; the web-side parts (rides, push, calls, messages) are checked here.
 * Anything unexpected rejects the whole snapshot: the server then starts fresh instead of half-restoring.
 */

export const SNAPSHOT_VERSION = 1;

export interface RuntimeState {
  store: StoreSnapshot;
  rides: Ride[];
  vehicles: Record<string, VehicleKind>;
  messages: Record<string, BoxMessage[]>;
  maintainer_alerts: MaintainerAlert[];
  push: {
    subscriptions: Record<string, PushSubscriptionJson[]>;
    /** The public key the subscriptions were made with (they're dropped on restore if it changed). */
    public_key: string;
    /** The generated VAPID pair, when no VAPID_* env keys were set (null with env keys). */
    vapid: { publicKey: string; privateKey: string } | null;
  };
  calls: CallBookSnapshot;
  coordinator: CoordinatorSnapshot;
  /** Optional state of other books that expose exportState/importState (e.g. text alerts). */
  extra?: Record<string, unknown>;
}

export interface Snapshot extends RuntimeState {
  version: typeof SNAPSHOT_VERSION;
  saved_at: string;
  /** The saving instance's start time (ms): an instance never overwrites a snapshot from a newer one. */
  generation: number;
}

/** What /api/state reports about persistence. */
export interface PersistenceStatus {
  /** DATABASE_URL is set. */
  enabled: boolean;
  /** This instance is writing snapshots (false without a database, after a failed load, or once a newer instance took over). */
  saving: boolean;
  last_saved_at: string | null;
  last_error: string | null;
  /** saved_at of the snapshot this instance started from, or null (fresh start). */
  restored_from: string | null;
  generation: number | null;
}

export const PERSISTENCE_OFF: PersistenceStatus = { enabled: false, saving: false, last_saved_at: null, last_error: null, restored_from: null, generation: null };

export type ParseResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

class Invalid extends Error {}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Invalid(what);
}
const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const strArr = (v: unknown) => Array.isArray(v) && v.every(str);
const RIDE_STATES = new Set(["planning", "offered", "accepted", "cancelled"]);
const OFFER_STATES = new Set(["offered", "accepted", "declined", "expired", "withdrawn", "lost"]);
const CALL_KINDS = new Set(["alert", "ride"]);
const CALL_STATUSES = new Set(["placed", "failed", "would_call", "capped", "quiet"]);

function checkRide(r: unknown, at: string): Ride {
  need(isObj(r), `${at}: not an object`);
  for (const k of ["ride_id", "incident_id", "box_id", "created_at"]) need(str(r[k]), `${at}.${k}`);
  need(strOrNull(r.note), `${at}.note`);
  need(RIDE_STATES.has(r.state as string), `${at}.state`);
  need(Array.isArray(r.offers), `${at}.offers`);
  r.offers.forEach((f: unknown, i: number) => {
    need(isObj(f), `${at}.offers[${i}]`);
    for (const k of ["driver_id", "driver_name", "offered_at", "expires_at"]) need(str(f[k]), `${at}.offers[${i}].${k}`);
    need(OFFER_STATES.has(f.state as string), `${at}.offers[${i}].state`);
    need(strOrNull(f.answered_at), `${at}.offers[${i}].answered_at`);
    f.seen_at ??= null;
    need(strOrNull(f.seen_at), `${at}.offers[${i}].seen_at`);
  });
  need(strArr(r.skipped), `${at}.skipped`);
  const w = r.winner;
  need(w === null || (isObj(w) && str(w.driver_id) && str(w.driver_name) && num(w.pickup_minutes)), `${at}.winner`);
  const h = r.hospital;
  need(isObj(h) && str(h.name) && isObj(h.location) && num(h.location.lat) && num(h.location.lng), `${at}.hospital`);
  need(num(r.seats_needed), `${at}.seats_needed`);
  const t = r.trip;
  need(t === null || (isObj(t) && (TRIP_STEPS as readonly string[]).includes(t.step as string) && str(t.at)), `${at}.trip`);
  return r as unknown as Ride;
}

function checkRecordOf<T>(v: unknown, at: string, each: (item: unknown, at: string) => T): Record<string, T> {
  need(isObj(v), `${at}: not an object`);
  return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, each(item, `${at}.${k}`)]));
}

function checkWeb(raw: Record<string, unknown>): Omit<RuntimeState, "store" | "coordinator"> {
  need(Array.isArray(raw.rides), "rides");
  const rides = raw.rides.map((r, i) => checkRide(r, `rides[${i}]`));
  const vehicles = checkRecordOf(raw.vehicles, "vehicles", (v, at) => {
    need(VEHICLE_KINDS.includes(v as VehicleKind), at);
    return v as VehicleKind;
  });
  const messages = checkRecordOf(raw.messages, "messages", (list, at) => {
    need(Array.isArray(list), at);
    return list.map((m, i) => {
      need(isObj(m) && ["incident_id", "box_id", "from_id", "from", "text", "at"].every((k) => str(m[k])), `${at}[${i}]`);
      return m as unknown as BoxMessage;
    });
  });
  need(Array.isArray(raw.maintainer_alerts), "maintainer_alerts");
  const maintainer_alerts = raw.maintainer_alerts.map((a, i) => {
    need(isObj(a) && (a.kind === "low_supplies" || a.kind === "offline") && str(a.box_id) && str(a.box_name) && str(a.at) && strArr(a.skus) && strArr(a.event_ids), `maintainer_alerts[${i}]`);
    return a as unknown as MaintainerAlert;
  });
  const p = raw.push;
  need(isObj(p) && str(p.public_key), "push");
  const subscriptions = checkRecordOf(p.subscriptions, "push.subscriptions", (list, at) => {
    need(Array.isArray(list), at);
    return list as PushSubscriptionJson[]; // each one is re-checked (and dropped if malformed) by the push book
  });
  const v = p.vapid;
  need(v === null || (isObj(v) && str(v.publicKey) && str(v.privateKey)), "push.vapid");
  const c = raw.calls;
  need(isObj(c) && strArr(c.decided), "calls.decided");
  const history = checkRecordOf(c.history, "calls.history", (list, at) => {
    need(Array.isArray(list) && list.every(num), at);
    return list as number[];
  });
  need(Array.isArray(c.entries), "calls.entries");
  c.entries.forEach((e: unknown, i: number) =>
    need(isObj(e) && str(e.alert_id) && CALL_KINDS.has(e.kind as string) && str(e.volunteer_id) && str(e.to) && CALL_STATUSES.has(e.status as string) && str(e.at), `calls.entries[${i}]`),
  );
  const extra = raw.extra === undefined ? undefined : checkRecordOf(raw.extra, "extra", (x) => x);
  return {
    rides,
    vehicles,
    messages,
    maintainer_alerts,
    push: { subscriptions, public_key: p.public_key as string, vapid: v as RuntimeState["push"]["vapid"] },
    calls: { decided: c.decided as string[], history, entries: c.entries as CallBookSnapshot["entries"] },
    ...(extra ? { extra } : {}),
  };
}

/** Checks a stored snapshot. Never throws: an unknown version or any invalid part is a reason, not an exception. */
export function parseSnapshot(raw: unknown): ParseResult {
  try {
    const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : structuredClone(raw);
    if (!isObj(value)) return { ok: false, reason: "not a JSON object" };
    if (value.version !== SNAPSHOT_VERSION) return { ok: false, reason: `unknown snapshot version ${JSON.stringify(value.version)} (this server reads version ${SNAPSHOT_VERSION})` };
    if (!str(value.saved_at)) return { ok: false, reason: "saved_at missing" };
    if (!num(value.generation)) return { ok: false, reason: "generation missing" };
    const store = StoreSnapshotSchema.safeParse(value.store);
    if (!store.success) return { ok: false, reason: `store: ${store.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    const coordinator = CoordinatorSnapshotSchema.safeParse(value.coordinator);
    if (!coordinator.success) return { ok: false, reason: `coordinator: ${coordinator.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    const web = checkWeb(value);
    return {
      ok: true,
      snapshot: { version: SNAPSHOT_VERSION, saved_at: value.saved_at as string, generation: value.generation as number, store: store.data, coordinator: coordinator.data, ...web },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Invalid ? `invalid ${error.message}` : `unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
}

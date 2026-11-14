// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/status.ts.
// As there, the status view is built only from stored data: online from the last heartbeat, the rest from the
// event log; here for first-aid boxes instead of a walker.
import type { BoxRecord, BoxStatus, LatLng } from "@clara/contracts";
import { OFFLINE_AFTER_MS } from "./config.js";
import type { BoxEntry, Store } from "./store.js";
import { restock, supplyLedger, type MaintainerAlert, type SupplyLedger } from "./supplies.js";

export interface BoxRegistration {
  box_id: string;
  name: string;
  location: LatLng;
  directions: string;
  /** Stocked count per sku. */
  manifest: Record<string, number>;
}

export function registerBox(store: Store, reg: BoxRegistration): BoxRecord {
  const existing = store.getBox(reg.box_id);
  const entry: BoxEntry = existing
    ? { ...existing, box: { ...existing.box, name: reg.name, location: reg.location, directions: reg.directions }, manifest: { ...reg.manifest } }
    : {
        box: { box_id: reg.box_id, name: reg.name, location: reg.location, directions: reg.directions, status: "offline", last_seen_at: null, battery_pct: null },
        manifest: { ...reg.manifest },
        open_session_id: null,
        restock_seq: store.lastSeq(),
        restocked_at: null,
        low_alerted: false,
        offline_alerted: false,
      };
  store.putBox(entry);
  return entry.box;
}

export function isOnline(lastSeenAt: string | null, now: Date): boolean {
  if (lastSeenAt === null) return false;
  return now.getTime() - Date.parse(lastSeenAt) <= OFFLINE_AFTER_MS;
}

/** offline (no contact for 90 s) > in_use (lid open) > low_supplies > ready. */
export function deriveStatus(entry: BoxEntry, ledger: SupplyLedger, now: Date): BoxStatus {
  if (!isOnline(entry.box.last_seen_at, now)) return "offline";
  if (entry.open_session_id !== null) return "in_use";
  if (ledger.low_skus.length > 0) return "low_supplies";
  return "ready";
}

/**
 * Brings one box's status up to date and stores it. Returns any maintainer alert raised by the change (low
 * supplies once per restock, offline once per outage).
 */
export function refreshBox(store: Store, boxId: string, now: Date, cause: string[] = []): MaintainerAlert[] {
  const entry = store.getBox(boxId);
  if (!entry) return [];
  const ledger = supplyLedger(entry, store.eventsForBox(boxId));
  const status = deriveStatus(entry, ledger, now);
  const alerts: MaintainerAlert[] = [];
  const base = { box_id: boxId, box_name: entry.box.name, at: now.toISOString() };
  if (ledger.low_skus.length > 0 && !entry.low_alerted) {
    entry.low_alerted = true;
    const crossed = ledger.items.filter((i) => i.low).flatMap((i) => i.event_ids);
    alerts.push({ kind: "low_supplies", ...base, skus: ledger.low_skus, event_ids: cause.length > 0 ? cause.filter((id) => crossed.includes(id)) : crossed });
  }
  if (status === "offline" && entry.box.last_seen_at !== null && !entry.offline_alerted) {
    entry.offline_alerted = true;
    alerts.push({ kind: "offline", ...base, skus: [], event_ids: [] });
  }
  if (status !== "offline") entry.offline_alerted = false;
  entry.box.status = status;
  store.putBox(entry);
  return alerts;
}

export function refreshAllBoxes(store: Store, now: Date): MaintainerAlert[] {
  return store.listBoxes().flatMap((e) => refreshBox(store, e.box.box_id, now));
}

/** A pin on the Lime-style kit map. */
export interface KitPin {
  box_id: string;
  name: string;
  location: LatLng;
  directions: string;
  status: BoxStatus;
  /** When the server last heard from the box; null if never. */
  last_updated_at: string | null;
  /** Whole seconds since then, by the server's clock; null if never. */
  last_updated_seconds_ago: number | null;
  battery_pct: number | null;
  /** The box's open incident, so the map can mark "emergency here". */
  open_incident_id: string | null;
}

export function kitMap(store: Store, now: Date): KitPin[] {
  return store.listBoxes().map(({ box, ...entry }) => {
    const ledger = supplyLedger({ box, ...entry }, store.eventsForBox(box.box_id));
    const status = deriveStatus({ box, ...entry }, ledger, now);
    return {
      box_id: box.box_id,
      name: box.name,
      location: box.location,
      directions: box.directions,
      status,
      last_updated_at: box.last_seen_at,
      last_updated_seconds_ago: box.last_seen_at === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(box.last_seen_at)) / 1000)),
      battery_pct: box.battery_pct,
      open_incident_id: store.openIncidentForBox(box.box_id)?.incident.incident_id ?? null,
    };
  });
}

/** One row of the maintainer backend: status, heartbeat, supply counts. */
export interface MaintainerRow {
  box: BoxRecord;
  online: boolean;
  supplies: SupplyLedger;
}

export function maintainerView(store: Store, now: Date): MaintainerRow[] {
  return store.listBoxes().map((entry) => {
    const supplies = supplyLedger(entry, store.eventsForBox(entry.box.box_id));
    return { box: { ...entry.box, status: deriveStatus(entry, supplies, now) }, online: isOnline(entry.box.last_seen_at, now), supplies };
  });
}

export { restock };

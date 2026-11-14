import { LOW_SUPPLY_FRACTION } from "./config.js";
import type { BoxEntry, Store, StoredEvent } from "./store.js";

/**
 * The running supply count (feature 19): only *confirmed* supply.used lowers stock (the model's proposed list
 * counts for nothing until a person taps to confirm); a restock resets it. No weight or slot sensors.
 */

export interface SupplyItem {
  sku: string;
  stocked: number;
  used: number;
  remaining: number;
  low: boolean;
  /** The confirmed supply.used events counted. */
  event_ids: string[];
}

export interface SupplyLedger {
  box_id: string;
  restocked_at: string | null;
  items: SupplyItem[];
  low_skus: string[];
  /** Confirmed use of skus not in the manifest: shown, never counted toward low. */
  unlisted: { sku: string; used: number; event_ids: string[] }[];
}

export interface MaintainerAlert {
  kind: "low_supplies" | "offline";
  box_id: string;
  box_name: string;
  at: string;
  /** For low_supplies: the low skus. */
  skus: string[];
  /** The events behind it (the supply.used that crossed the line). */
  event_ids: string[];
}

export function isLow(stocked: number, remaining: number): boolean {
  return stocked > 0 && remaining <= stocked * LOW_SUPPLY_FRACTION;
}

export function supplyLedger(entry: BoxEntry, events: readonly StoredEvent[]): SupplyLedger {
  const used = new Map<string, { used: number; event_ids: string[] }>();
  for (const { seq, event } of events) {
    if (seq <= entry.restock_seq || event.type !== "supply.used" || !event.confirmed) continue;
    const row = used.get(event.sku) ?? { used: 0, event_ids: [] };
    row.used += event.qty;
    row.event_ids.push(event.event_id);
    used.set(event.sku, row);
  }
  const items = Object.entries(entry.manifest).map(([sku, stocked]): SupplyItem => {
    const row = used.get(sku) ?? { used: 0, event_ids: [] };
    const remaining = Math.max(0, stocked - row.used);
    return { sku, stocked, used: row.used, remaining, low: isLow(stocked, remaining), event_ids: row.event_ids };
  });
  return {
    box_id: entry.box.box_id,
    restocked_at: entry.restocked_at,
    items,
    low_skus: items.filter((i) => i.low).map((i) => i.sku),
    unlisted: [...used.entries()].filter(([sku]) => !(sku in entry.manifest)).map(([sku, row]) => ({ sku, ...row })),
  };
}

/** The box was refilled: counts start again from the manifest (optionally a new one). */
export function restock(store: Store, boxId: string, now: Date, manifest?: Record<string, number>): BoxEntry | undefined {
  const entry = store.getBox(boxId);
  if (!entry) return undefined;
  entry.manifest = manifest ? { ...manifest } : entry.manifest;
  entry.restock_seq = store.lastSeq();
  entry.restocked_at = now.toISOString();
  entry.low_alerted = false;
  store.putBox(entry);
  return entry;
}

import { randomUUID } from "node:crypto";
import { EVENTS_VERSION } from "@clara/contracts";
import type { Network } from "@clara/network";

/**
 * Automatic supply count (demo assumption): when the box shows a guided step that uses a kit item, assume the
 * bystander took one of it, and record a confirmed `supply.used` for that box. Once per item per step per session.
 * The box's minimal screen has no confirmation control, so this keeps the maintainer page's stock and restock
 * alerts moving. It is an estimate from the guidance shown, not a sensor reading.
 */

type Step = { step_id: string; item?: string };
type Scenario = { scenario_id: string; steps: Step[] };

/** Scenario item ids → the stock names the boxes are registered with. Items not stocked (scissors) aren't counted. */
const STOCK_ALIASES: Record<string, string> = {
  tourniquet: "tourniquet",
  hemostatic_gauze: "gauze",
  gauze: "gauze",
  pressure_bandage: "pressure_bandage",
  gloves: "gloves",
  blanket: "emergency_blanket",
  emergency_blanket: "emergency_blanket",
  cpr_mask: "cpr_mask",
};

export function stockSku(item: string): string | null {
  return STOCK_ALIASES[item.toLowerCase()] ?? null;
}

export function createAutoSupply({ network, scenarios }: { network: Network; scenarios: readonly Scenario[] }): { stop(): void } {
  const itemOf = new Map<string, string>();
  for (const s of scenarios) for (const step of s.steps) if (step.item) itemOf.set(`${s.scenario_id}:${step.step_id}`, step.item);
  const counted = new Set<string>();

  const unsubscribe = network.subscribe((change) => {
    if (change.kind !== "event" || change.event.type !== "step.shown") return;
    const e = change.event;
    const item = itemOf.get(`${e.scenario_id}:${e.step_id}`);
    const sku = item ? stockSku(item) : null;
    if (!sku || !e.session_id) return;
    const key = `${e.box_id}|${e.session_id}|${e.scenario_id}|${e.step_id}|${sku}`;
    if (counted.has(key)) return;
    counted.add(key);
    if (counted.size > 5_000) counted.clear();
    // Only items the box is stocked with are counted.
    const ledger = network.supplies(e.box_id);
    if (!ledger || !ledger.items.some((i) => i.sku === sku)) return;
    // Recorded after the current event finishes, so the store isn't re-entered mid-emit.
    queueMicrotask(() => {
      try {
        network.ingest({
          schema_version: EVENTS_VERSION,
          events: [{ event_id: randomUUID(), box_id: e.box_id, session_id: e.session_id, occurred_at: new Date().toISOString(), type: "supply.used", sku, qty: 1, confirmed: true }],
        });
      } catch (error) {
        console.error("[supplies] couldn't record automatic usage:", (error as Error).message);
      }
    });
  });
  return { stop: unsubscribe };
}

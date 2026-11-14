import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, type BoxEvent, type EventBatch } from "@clara/contracts";

/**
 * Demo helper events (no hardware): what a box would post when the lid opens and the SOS countdown finishes,
 * or when the lid closes. Source "system" and fresh ids, exactly as the contract wants.
 */
export type Need = "bleeding" | "breathing" | "general";

export function demoSosBatch(boxId: string, need: Need, now: Date, sessionId: string = randomUUID()): EventBatch {
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
  const base = { box_id: boxId, session_id: sessionId };
  const events: BoxEvent[] = [
    { ...base, event_id: randomUUID(), occurred_at: at(0), type: "box.opened" },
    { ...base, event_id: randomUUID(), occurred_at: at(1), type: "sos.opened", need, source: "system" },
  ];
  return { schema_version: EVENTS_VERSION, events };
}

export function demoCloseBatch(boxId: string, sessionId: string | null, now: Date): EventBatch {
  return {
    schema_version: EVENTS_VERSION,
    events: [{ event_id: randomUUID(), box_id: boxId, session_id: sessionId, occurred_at: now.toISOString(), type: "box.closed" }],
  };
}

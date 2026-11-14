import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, type BoxEvent, type EventBatch } from "@clara/contracts";
import { createNetwork, sequentialIds, type Network } from "../src/index.js";

export const T0 = Date.parse("2026-11-13T19:00:00.000Z"); // 2:00 PM in Princeton

export interface Harness {
  net: Network;
  now: { ms: number };
  advance(ms: number): void;
  at(offsetMs?: number): string;
}

/** A seeded network on a fake clock starting at T0. */
export function harness(): Harness {
  const now = { ms: T0 };
  const net = createNetwork({ clock: () => new Date(now.ms), ids: sequentialIds() });
  net.seedDemo();
  return { net, now, advance: (ms) => void (now.ms += ms), at: (offset = 0) => new Date(now.ms + offset).toISOString() };
}

type Body<T extends BoxEvent["type"]> = Omit<Extract<BoxEvent, { type: T }>, "event_id" | "box_id" | "session_id" | "occurred_at" | "type">;

/** Builds events for one box and one lid session. */
export function boxEvents(box_id: string, session_id: string | null = randomUUID()) {
  const make = <T extends BoxEvent["type"]>(type: T, occurred_at: string, body: Body<T>): BoxEvent =>
    ({ event_id: randomUUID(), box_id, session_id, occurred_at, type, ...body }) as BoxEvent;
  return { session_id, make };
}

export const batch = (...events: BoxEvent[]): EventBatch => ({ schema_version: EVENTS_VERSION, events });

/** Heartbeat so the box is online at the harness's current time. */
export function heartbeat(h: Harness, box_id: string) {
  const { make } = boxEvents(box_id, null);
  return h.net.ingest(batch(make("box.heartbeat", h.at(), { battery_pct: 80, online_parts: ["esp32"] })));
}

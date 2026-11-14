import { z } from "zod";
import { Id } from "./scenario.js";

/**
 * Box events: the one language between the box, the server and the apps. The box appends them to its
 * log and posts them to the server; the timeline, handoff card, scene report and dashboard are all views
 * of this list.
 */

export const EVENTS_VERSION = "events/0.1";

const base = {
  event_id: z.uuid(),
  box_id: Id,
  /** One lid-open session. */
  session_id: z.uuid().nullable(),
  occurred_at: z.iso.datetime(),
};

export const SourceSchema = z.enum(["touch", "voice", "device", "system"]);

export const BoxEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("box.opened") }),
  z.strictObject({ ...base, type: z.literal("box.closed") }),
  z.strictObject({ ...base, type: z.literal("box.heartbeat"), battery_pct: z.number().min(0).max(100).nullable(), online_parts: z.array(z.string()).max(20) }),
  z.strictObject({ ...base, type: z.literal("scenario.started"), scenario_id: Id, source: SourceSchema }),
  z.strictObject({ ...base, type: z.literal("step.shown"), scenario_id: Id, step_id: Id, source: SourceSchema }),
  z.strictObject({ ...base, type: z.literal("step.done"), scenario_id: Id, step_id: Id, source: SourceSchema }),
  z.strictObject({ ...base, type: z.literal("timer.started"), timer: z.enum(["tourniquet", "pressure"]), step_id: Id }),
  /** What the bystander said, as heard. A report, never a fact. */
  z.strictObject({ ...base, type: z.literal("report.heard"), text: z.string().max(1000) }),
  z.strictObject({ ...base, type: z.literal("sos.countdown"), seconds: z.number().int().min(0).max(30), source: SourceSchema }),
  z.strictObject({ ...base, type: z.literal("sos.cancelled"), source: SourceSchema }),
  /** The countdown finished: the simulated 911 call shows and the network is alerted. */
  z.strictObject({ ...base, type: z.literal("sos.opened"), need: z.enum(["bleeding", "breathing", "general"]), source: SourceSchema }),
  z.strictObject({ ...base, type: z.literal("supply.used"), sku: Id, qty: z.number().int().min(1).max(99), confirmed: z.boolean() }),
  z.strictObject({ ...base, type: z.literal("sensor.pulse"), bpm: z.number().int().min(20).max(250).nullable(), quality: z.enum(["valid", "suspect", "unavailable"]) }),
  z.strictObject({ ...base, type: z.literal("photo.taken"), photo_id: Id, purpose: z.string().max(80) }),
  z.strictObject({ ...base, type: z.literal("triage.tagged"), patient: z.number().int().min(1).max(50), tag: z.enum(["red", "yellow", "green", "black"]) }),
]);
export type BoxEvent = z.infer<typeof BoxEventSchema>;
export type BoxEventType = BoxEvent["type"];

/** What the box posts: a batch of events, oldest first. Re-sending an event_id is harmless. */
export const EventBatchSchema = z.strictObject({
  schema_version: z.literal(EVENTS_VERSION),
  events: z.array(BoxEventSchema).min(1).max(100),
});
export type EventBatch = z.infer<typeof EventBatchSchema>;

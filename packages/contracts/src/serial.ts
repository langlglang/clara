import { z } from "zod";

/**
 * Pi ↔ ESP32 over USB serial: one JSON object per line, at most 1 KiB, 115200 baud. The framing and
 * the ack pattern follow Sophi's serial contract (github.com/mzhao1599/sophi, packages/contracts/src/serial.ts).
 */

export const SERIAL_BAUD = 115_200;
export const SERIAL_MAX_LINE = 1_024;

/** ESP32 → Pi. */
export const FromBoardSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("hello"), fw: z.string().max(32), boot: z.string().max(32), leds: z.number().int().min(0).max(16) }),
  z.strictObject({ t: z.literal("lid"), open: z.boolean(), seq: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("mount"), on_wall: z.boolean(), seq: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("pulse"), bpm: z.number().int().min(0).max(250).nullable(), quality: z.enum(["valid", "suspect", "unavailable"]), seq: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("ack"), id: z.number().int().min(0), ok: z.boolean(), err: z.string().max(80).optional() }),
]);
export type FromBoard = z.infer<typeof FromBoardSchema>;

/** Pi → ESP32. Every command has an id the board acks. */
export const ToBoardSchema = z.discriminatedUnion("t", [
  /** Light exactly one compartment for `ms` (others off); channel -1 clears all. */
  z.strictObject({ t: z.literal("led"), id: z.number().int().min(0), ch: z.number().int().min(-1).max(15), ms: z.number().int().min(0).max(60_000), mode: z.enum(["solid", "blink", "pulse"]) }),
  /** CPR rhythm or SOS flash on every LED: `bpm` 0 stops it. */
  z.strictObject({ t: z.literal("rhythm"), id: z.number().int().min(0), bpm: z.number().int().min(0).max(200), pattern: z.enum(["beat", "sos"]).optional() }),
  z.strictObject({ t: z.literal("buzz"), id: z.number().int().min(0), pattern: z.enum(["chime", "alert", "off"]) }),
  z.strictObject({ t: z.literal("pulse.start"), id: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("pulse.stop"), id: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("ping"), id: z.number().int().min(0) }),
]);
export type ToBoard = z.infer<typeof ToBoardSchema>;

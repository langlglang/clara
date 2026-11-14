import { randomUUID } from "node:crypto";
import { BoxEventSchema, type BoxEvent, type BoxEventType } from "@clara/contracts";

type BaseKeys = "event_id" | "box_id" | "session_id" | "occurred_at" | "type";
/** The fields of one event type besides the ones every event carries. */
export type EventBody<T extends BoxEventType> = Omit<Extract<BoxEvent, { type: T }>, BaseKeys>;

/**
 * Stamps box events with the box id, the current lid-open session, a fresh event id and the time, and checks
 * each against the shared contract. An event that doesn't match is logged and dropped, never sent.
 */
export class EventFactory {
  sessionId: string | null = null;

  constructor(
    readonly boxId: string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    private readonly log: (line: string) => void = () => {},
  ) {}

  make<T extends BoxEventType>(type: T, body: EventBody<T>): BoxEvent | null {
    const parsed = BoxEventSchema.safeParse({
      event_id: this.newId(),
      box_id: this.boxId,
      session_id: this.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      type,
      ...body,
    });
    if (!parsed.success) {
      this.log(`event ${type} dropped: it doesn't match the events contract`);
      return null;
    }
    return parsed.data;
  }
}

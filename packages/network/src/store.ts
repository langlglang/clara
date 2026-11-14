// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/store.ts.
// Same shape as Sophi's memory store: one interface a database can implement later, synchronous steps so each
// change is atomic, copies out so callers can't mutate stored rows, and idempotent ids (event_id here, where
// Sophi used client_help_id).
import { BoxEventSchema, BoxRecordSchema, IncidentSchema, VolunteerSchema, type BoxEvent, type BoxRecord, type Incident, type Volunteer } from "@clara/contracts";
import { z } from "zod";

/** A registered box with what the server keeps beside the contract's BoxRecord. */
export interface BoxEntry {
  box: BoxRecord;
  /** Stocked counts per sku, given at registration (or the last restock). */
  manifest: Record<string, number>;
  /** The lid-open session in progress, or null when the lid is closed. */
  open_session_id: string | null;
  /** Supply events at or below this sequence number were before the last restock. */
  restock_seq: number;
  restocked_at: string | null;
  /** A low-supplies maintainer alert was raised since the last restock. */
  low_alerted: boolean;
  /** An offline maintainer alert was raised since the box was last seen. */
  offline_alerted: boolean;
}

/** One accepted event, numbered in the order the server received it. */
export interface StoredEvent {
  seq: number;
  received_at: string;
  event: BoxEvent;
}

/** An incident with the server's own bookkeeping. */
export interface IncidentEntry {
  incident: Incident;
  /** The sos.opened that opened it. */
  sos_event_id: string;
  /** Boxes told about it with nearby.emergency (so they get nearby.clear on close). */
  nearby_box_ids: string[];
}

export type StoreChange =
  | { kind: "box"; box: BoxRecord }
  | { kind: "volunteer"; volunteer: Volunteer }
  | { kind: "event"; event: BoxEvent }
  | { kind: "incident"; incident: Incident };

export type StoreListener = (change: StoreChange) => void;

/** Heartbeats kept per box in a snapshot (they only carry the battery, which the box record already holds). */
export const SNAPSHOT_HEARTBEATS_PER_BOX = 5;

const IsoTime = z.string().min(1).max(64);

/** Everything the store holds, as plain JSON (persistence snapshots). Checked with the contract schemas on import. */
export const StoreSnapshotSchema = z.object({
  boxes: z.array(
    z.object({
      box: BoxRecordSchema,
      manifest: z.record(z.string(), z.number().int().min(0)),
      open_session_id: z.string().nullable(),
      restock_seq: z.number().int().min(0),
      restocked_at: IsoTime.nullable(),
      low_alerted: z.boolean(),
      offline_alerted: z.boolean(),
    }),
  ),
  volunteers: z.array(VolunteerSchema),
  events: z.array(z.object({ seq: z.number().int().min(1), received_at: IsoTime, event: BoxEventSchema })),
  /** The highest sequence number given out (old heartbeats are trimmed, so it can exceed the last event's). */
  last_seq: z.number().int().min(0),
  incidents: z.array(z.object({ incident: IncidentSchema, sos_event_id: z.string().min(1), nearby_box_ids: z.array(z.string()) })),
});
export type StoreSnapshot = z.infer<typeof StoreSnapshotSchema>;

/**
 * Everything the network keeps. Synchronous for the in-memory demo; a Supabase store would wrap the same steps
 * in transactions (and the facade would become async).
 */
export interface Store {
  getBox(boxId: string): BoxEntry | undefined;
  listBoxes(): BoxEntry[];
  putBox(entry: BoxEntry): void;

  getVolunteer(volunteerId: string): Volunteer | undefined;
  listVolunteers(): Volunteer[];
  putVolunteer(volunteer: Volunteer): void;

  /** Keeps the event and numbers it; null (and nothing stored) when its event_id was seen before. */
  addEvent(event: BoxEvent, receivedAt: string): StoredEvent | null;
  hasEvent(eventId: string): boolean;
  /** This box's events in the order received. */
  eventsForBox(boxId: string): StoredEvent[];
  /** The highest sequence number given so far (0 before any event). */
  lastSeq(): number;

  getIncident(incidentId: string): IncidentEntry | undefined;
  listIncidents(): IncidentEntry[];
  putIncident(entry: IncidentEntry): void;
  /** The box's one open incident, if any. */
  openIncidentForBox(boxId: string): IncidentEntry | undefined;
  incidentByToken(token: string): IncidentEntry | undefined;
  /** The incident holding this alert. */
  incidentByAlert(alertId: string): IncidentEntry | undefined;

  /** Live changes for boxes, dashboards and apps. Returns the unsubscribe function. */
  subscribe(listener: StoreListener): () => void;

  /** Everything held, as plain JSON (old heartbeats left out). */
  exportState(): StoreSnapshot;
  /** Replaces everything with a snapshot. Validates first and throws on invalid data, leaving the store unchanged; emits nothing. */
  importState(snapshot: unknown): void;
}

const copy = <T>(value: T): T => structuredClone(value);

export function createMemoryStore(): Store {
  const boxes = new Map<string, BoxEntry>();
  const volunteers = new Map<string, Volunteer>();
  let events: StoredEvent[] = [];
  const eventIds = new Set<string>();
  let seq = 0;
  const incidents = new Map<string, IncidentEntry>();
  const listeners = new Set<StoreListener>();

  const emit = (change: StoreChange) => {
    for (const listener of [...listeners]) {
      try {
        listener(copy(change));
      } catch {
        // A broken listener never breaks the store.
      }
    }
  };

  return {
    getBox: (id) => (boxes.has(id) ? copy(boxes.get(id)!) : undefined),
    listBoxes: () => [...boxes.values()].map(copy),
    putBox(entry) {
      const before = boxes.get(entry.box.box_id);
      boxes.set(entry.box.box_id, copy(entry));
      if (!before || JSON.stringify(before.box) !== JSON.stringify(entry.box)) emit({ kind: "box", box: entry.box });
    },

    getVolunteer: (id) => (volunteers.has(id) ? copy(volunteers.get(id)!) : undefined),
    listVolunteers: () => [...volunteers.values()].map(copy),
    putVolunteer(volunteer) {
      volunteers.set(volunteer.volunteer_id, copy(volunteer));
      emit({ kind: "volunteer", volunteer });
    },

    addEvent(event, receivedAt) {
      if (eventIds.has(event.event_id)) return null;
      eventIds.add(event.event_id);
      const stored: StoredEvent = { seq: ++seq, received_at: receivedAt, event: copy(event) };
      events.push(stored);
      emit({ kind: "event", event });
      return copy(stored);
    },
    hasEvent: (id) => eventIds.has(id),
    eventsForBox: (boxId) => events.filter((e) => e.event.box_id === boxId).map(copy),
    lastSeq: () => seq,

    getIncident: (id) => (incidents.has(id) ? copy(incidents.get(id)!) : undefined),
    listIncidents: () => [...incidents.values()].map(copy),
    putIncident(entry) {
      incidents.set(entry.incident.incident_id, copy(entry));
      emit({ kind: "incident", incident: entry.incident });
    },
    openIncidentForBox(boxId) {
      const found = [...incidents.values()].find((e) => e.incident.box_id === boxId && e.incident.closed === null);
      return found ? copy(found) : undefined;
    },
    incidentByToken(token) {
      const found = [...incidents.values()].find((e) => e.incident.report_token === token);
      return found ? copy(found) : undefined;
    },
    incidentByAlert(alertId) {
      const found = [...incidents.values()].find((e) => e.incident.alerts.some((a) => a.alert_id === alertId));
      return found ? copy(found) : undefined;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    exportState() {
      // Every event except old heartbeats: the newest few per box are enough (battery and last seen live on the box).
      const keepBeat = new Set<number>();
      const perBox = new Map<string, number>();
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.event.type !== "box.heartbeat") continue;
        const n = perBox.get(e.event.box_id) ?? 0;
        if (n < SNAPSHOT_HEARTBEATS_PER_BOX) keepBeat.add(e.seq);
        perBox.set(e.event.box_id, n + 1);
      }
      return copy({
        boxes: [...boxes.values()],
        volunteers: [...volunteers.values()],
        events: events.filter((e) => e.event.type !== "box.heartbeat" || keepBeat.has(e.seq)),
        last_seq: seq,
        incidents: [...incidents.values()],
      });
    },
    importState(snapshot) {
      const s = StoreSnapshotSchema.parse(snapshot);
      boxes.clear();
      volunteers.clear();
      incidents.clear();
      eventIds.clear();
      for (const b of s.boxes) boxes.set(b.box.box_id, b as BoxEntry);
      for (const v of s.volunteers) volunteers.set(v.volunteer_id, v);
      events = [...s.events].sort((a, b) => a.seq - b.seq) as StoredEvent[];
      for (const e of events) eventIds.add(e.event.event_id);
      seq = Math.max(s.last_seq, events.at(-1)?.seq ?? 0);
      for (const i of s.incidents) incidents.set(i.incident.incident_id, i);
    },
  };
}

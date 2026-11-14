import { AlertResponseSchema, VolunteerSchema, type Alert, type BoxRecord, type Incident, type Volunteer } from "@clara/contracts";
import { alertVolunteers, comingLineForBox, escalationOf, inbox, requestKit, respond, tickIncidents, candidatesFor, type AlertVolunteersResult, type EscalationView, type Push, type RequestKitResult, type RespondResult } from "./alerts.js";
import { kitMap, maintainerView, refreshAllBoxes, refreshBox, registerBox, restock, type BoxRegistration, type KitPin, type MaintainerRow } from "./boxes.js";
import { randomIds, type Clock, type Ids } from "./config.js";
import { ingest, type IngestResult } from "./events.js";
import type { Candidate } from "./matching.js";
import { buildSceneReport, type ReportOptions, type SceneReport } from "./report.js";
import { DEMO_BOXES, DEMO_VOLUNTEERS } from "./seed.js";
import { createMemoryStore, type Store, type StoreChange } from "./store.js";
import { supplyLedger, type MaintainerAlert, type SupplyLedger } from "./supplies.js";

export * from "./alerts.js";
export * from "./boxes.js";
export * from "./config.js";
export * from "./events.js";
export * from "./matching.js";
export * from "./report.js";
export * from "./seed.js";
export * from "./store.js";
export * from "./supplies.js";

/** Everything a live listener (box stream, dashboard, companion app) can receive. */
export type NetworkChange = StoreChange | { kind: "push"; box_id: string; push: Push["push"] } | { kind: "maintainer"; alert: MaintainerAlert };

export interface TickResult {
  pushes: Push[];
  maintainer: MaintainerAlert[];
}

export interface IncidentView {
  incident: Incident;
  box: BoxRecord | null;
  coming_line: string | null;
  escalation: EscalationView;
}

export interface NetworkOptions {
  store?: Store;
  clock?: Clock;
  ids?: Ids;
}

export function createNetwork(options: NetworkOptions = {}) {
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? (() => new Date());
  const ids = options.ids ?? randomIds;
  const ctx = { store, ids };
  const listeners = new Set<(change: NetworkChange) => void>();

  const publish = (pushes: Push[], maintainer: MaintainerAlert[] = []) => {
    for (const listener of [...listeners]) {
      for (const p of pushes) safe(() => listener({ kind: "push", box_id: p.box_id, push: p.push }));
      for (const alert of maintainer) safe(() => listener({ kind: "maintainer", alert }));
    }
  };
  store.subscribe((change) => {
    for (const listener of [...listeners]) safe(() => listener(change));
  });

  const view = (incident: Incident, now: Date): IncidentView => ({
    incident,
    box: store.getBox(incident.box_id)?.box ?? null,
    coming_line: incident.closed === null ? comingLineForBox(store, incident.box_id) : null,
    escalation: escalationOf(incident, now),
  });

  return {
    store,
    clock,

    // ---- Registration ----
    registerBox: (reg: BoxRegistration): BoxRecord => registerBox(store, reg),
    registerVolunteer(input: Volunteer): Volunteer {
      const volunteer = VolunteerSchema.parse(input);
      store.putVolunteer(volunteer);
      return volunteer;
    },
    /** Changes profile fields (checked against the contract). A field set to `undefined` is removed. */
    updateVolunteer(volunteerId: string, patch: Partial<Omit<Volunteer, "volunteer_id">>): Volunteer | undefined {
      const current = store.getVolunteer(volunteerId);
      if (!current) return undefined;
      const merged: Record<string, unknown> = { ...current, ...patch };
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
      const next = VolunteerSchema.parse(merged);
      store.putVolunteer(next);
      return next;
    },
    /** Loads the fictional demo site. */
    seedDemo() {
      for (const box of DEMO_BOXES) registerBox(store, box);
      for (const v of DEMO_VOLUNTEERS) store.putVolunteer(v);
    },

    // ---- The box ----
    /** A batch the box posted. Re-sending is harmless. */
    ingest(batch: unknown): IngestResult {
      const result = ingest(ctx, batch, clock());
      if (result.ok) publish(result.pushes, result.maintainer);
      return result;
    },
    /** The only sentence the box may say about who is coming (null until a real accept). */
    comingLine: (boxId: string): string | null => comingLineForBox(store, boxId),

    // ---- Volunteers ----
    /** A volunteer's answer from the companion app (or a WhatsApp / iMessage reply mapped to one). */
    respond(alertId: string, volunteerId: string, action: unknown): RespondResult {
      const parsed = AlertResponseSchema.parse({ action });
      const result = respond(ctx, { alert_id: alertId, volunteer_id: volunteerId, action: parsed.action }, clock());
      if (result.outcome === "answered") publish(result.pushes);
      return result;
    },
    /** The companion app's alert list; fetching marks new alerts `shown`. */
    inbox(volunteerId: string): { incident: Incident; alert: Alert; box: BoxRecord | null }[] {
      const { alerts, pushes } = inbox(ctx, volunteerId, clock());
      publish(pushes);
      return alerts.map((a) => ({ ...a, box: store.getBox(a.incident.box_id)?.box ?? null }));
    },
    /** Who could still be alerted for an incident, best first. */
    candidates(incidentId: string): Candidate[] {
      const entry = store.getIncident(incidentId);
      return entry ? candidatesFor(store, entry) : [];
    },

    /**
     * Alerts named candidates now, beside the automatic waves (the response coordinator's bounded action). Ids that
     * aren't current candidates are refused with a reason; `reason` is for logs only and never reaches a volunteer.
     */
    alertVolunteers(incidentId: string, volunteerIds: readonly string[], _reason?: string): AlertVolunteersResult {
      const result = alertVolunteers(ctx, incidentId, volunteerIds, clock());
      if (result.outcome === "alerted") publish(result.pushes);
      return result;
    },
    /** Sends one other box the incident's nearby.emergency push ("bring this kit"). */
    requestKit(incidentId: string, boxId: string): RequestKitResult {
      const result = requestKit(ctx, incidentId, boxId);
      if (result.outcome === "requested") publish([result.push]);
      return result;
    },

    // ---- Time ----
    /** Escalation, incident expiry and offline boxes. Call it every few seconds; logic never starts a timer. */
    tick(now: Date = clock()): TickResult {
      const pushes = tickIncidents(ctx, now);
      const maintainer = refreshAllBoxes(store, now);
      publish(pushes, maintainer);
      return { pushes, maintainer };
    },

    // ---- Views ----
    incident(incidentId: string): IncidentView | undefined {
      const entry = store.getIncident(incidentId);
      return entry ? view(entry.incident, clock()) : undefined;
    },
    openIncidentForBox(boxId: string): IncidentView | undefined {
      const entry = store.openIncidentForBox(boxId);
      return entry ? view(entry.incident, clock()) : undefined;
    },
    /** The dispatch dashboard: newest first. */
    incidents(): IncidentView[] {
      const now = clock();
      return store
        .listIncidents()
        .map((e) => view(e.incident, now))
        .sort((a, b) => Date.parse(b.incident.opened_at) - Date.parse(a.incident.opened_at));
    },
    report(incidentId: string, opts?: ReportOptions): SceneReport | undefined {
      const entry = store.getIncident(incidentId);
      return entry ? buildSceneReport(store, entry, opts) : undefined;
    },
    /** The EMS link: the report for a secret token, or undefined. */
    reportByToken(token: string, opts?: ReportOptions): SceneReport | undefined {
      const entry = store.incidentByToken(token);
      return entry ? buildSceneReport(store, entry, opts) : undefined;
    },
    kitMap: (): KitPin[] => kitMap(store, clock()),
    maintainer: (): MaintainerRow[] => maintainerView(store, clock()),
    supplies(boxId: string): SupplyLedger | undefined {
      const entry = store.getBox(boxId);
      return entry ? supplyLedger(entry, store.eventsForBox(boxId)) : undefined;
    },
    restock(boxId: string, manifest?: Record<string, number>): SupplyLedger | undefined {
      const now = clock();
      const entry = restock(store, boxId, now, manifest);
      if (!entry) return undefined;
      publish([], refreshBox(store, boxId, now));
      return supplyLedger(store.getBox(boxId)!, store.eventsForBox(boxId));
    },

    // ---- Live ----
    subscribe(listener: (change: NetworkChange) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type Network = ReturnType<typeof createNetwork>;

function safe(fn: () => void) {
  try {
    fn();
  } catch {
    // A broken listener never breaks the network.
  }
}

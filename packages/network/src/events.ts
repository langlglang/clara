// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/store.ts (askForHelp) and
// docs/subsystems/help.md. Sophi's "one open request per walker; asking again returns it; a repeated client id is
// harmless" becomes: one open incident per box; a repeated sos.opened joins the open one; a re-sent event_id is
// ignored.
import { EventBatchSchema, type BoxEvent, type Incident } from "@clara/contracts";
import { closeHowForBoxClosed, closeIncident, startIncident, type AlertContext, type Push } from "./alerts.js";
import { refreshBox } from "./boxes.js";
import type { IncidentEntry } from "./store.js";
import type { MaintainerAlert } from "./supplies.js";

export type IngestResult =
  | {
      ok: true;
      accepted: string[];
      duplicates: string[];
      /** Events for a box the server doesn't know: not stored. */
      unknown_box: string[];
      /** Incidents this batch opened. */
      opened: Incident[];
      /** Incidents this batch closed. */
      closed: Incident[];
      pushes: Push[];
      maintainer: MaintainerAlert[];
    }
  | { ok: false; error: string };

/** Takes a batch the box posted (validated against the contract), oldest first. Safe to re-send. */
export function ingest(ctx: AlertContext, input: unknown, now: Date): IngestResult {
  const parsed = EventBatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const result = { ok: true as const, accepted: [] as string[], duplicates: [] as string[], unknown_box: [] as string[], opened: [] as Incident[], closed: [] as Incident[], pushes: [] as Push[], maintainer: [] as MaintainerAlert[] };
  const touched = new Map<string, string[]>();
  const at = now.toISOString();

  for (const event of parsed.data.events) {
    const entry = ctx.store.getBox(event.box_id);
    if (!entry) {
      result.unknown_box.push(event.event_id);
      continue;
    }
    if (!ctx.store.addEvent(event, at)) {
      result.duplicates.push(event.event_id);
      continue;
    }
    result.accepted.push(event.event_id);
    touched.set(event.box_id, [...(touched.get(event.box_id) ?? []), event.event_id]);

    // Any event is contact with the box; the heartbeat also carries the battery.
    entry.box.last_seen_at = at;
    if (event.type === "box.heartbeat") entry.box.battery_pct = event.battery_pct;
    if (event.type === "box.opened") entry.open_session_id = event.session_id;
    if (event.type === "box.closed") entry.open_session_id = null;
    ctx.store.putBox(entry);

    applyIncidentEvent(ctx, event, now, result);
  }

  for (const [boxId, eventIds] of touched) result.maintainer.push(...refreshBox(ctx.store, boxId, now, eventIds));
  return result;
}

function applyIncidentEvent(ctx: AlertContext, event: BoxEvent, now: Date, result: { opened: Incident[]; closed: Incident[]; pushes: Push[] }) {
  const open = ctx.store.openIncidentForBox(event.box_id);
  switch (event.type) {
    case "sos.opened": {
      if (open) return; // One open incident per box: a repeated SOS joins it.
      const entry: IncidentEntry = {
        incident: {
          incident_id: ctx.ids.id("inc"),
          box_id: event.box_id,
          // The contract wants a session uuid; an SOS outside a lid session uses its own event id (also a uuid).
          session_id: event.session_id ?? event.event_id,
          need: event.need,
          opened_at: now.toISOString(),
          closed: null,
          alerts: [],
          report_token: ctx.ids.token(),
        },
        sos_event_id: event.event_id,
        nearby_box_ids: [],
      };
      result.pushes.push(...startIncident(ctx, entry, now));
      result.opened.push(ctx.store.getIncident(entry.incident.incident_id)!.incident);
      return;
    }
    case "sos.cancelled": {
      // A cancel inside the countdown comes before any sos.opened and changes nothing here. A cancel after the
      // SOS in the same session ends it.
      if (!open || open.incident.session_id !== event.session_id) return;
      const sos = ctx.store.eventsForBox(event.box_id).find((e) => e.event.event_id === open.sos_event_id);
      if (sos && Date.parse(event.occurred_at) < Date.parse(sos.event.occurred_at)) return;
      result.pushes.push(...closeIncident(ctx, open, "cancelled", now));
      result.closed.push(open.incident);
      return;
    }
    case "box.closed": {
      if (!open) return;
      result.pushes.push(...closeIncident(ctx, open, closeHowForBoxClosed(open.incident), now));
      result.closed.push(open.incident);
      return;
    }
    default:
      return;
  }
}

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EVENTS_VERSION, type BoxEvent, type BoxPush } from "@clara/contracts";
import { createNetwork, sequentialIds } from "@clara/network";
import { createEmergencyWorker } from "../lib/emergency";

const now = new Date("2026-11-13T19:00:00.000Z");
const box_id = "box-clinic";
const session_id = randomUUID();
const base = () => ({ event_id: randomUUID(), box_id, session_id, occurred_at: now.toISOString() });
const event = <T extends BoxEvent["type"]>(type: T, fields: Omit<Extract<BoxEvent, { type: T }>, keyof ReturnType<typeof base> | "type">): Extract<BoxEvent, { type: T }> => ({ ...base(), type, ...fields }) as Extract<BoxEvent, { type: T }>;

function setup(restored?: unknown) {
  const network = createNetwork({ ids: sequentialIds(), clock: () => now });
  network.seedDemo();
  const pushes: BoxPush[] = [];
  const worker = createEmergencyWorker({ network, emit: (change) => pushes.push(change.push), contextWaitMs: 20, restored });
  const ingest = (...events: BoxEvent[]) => network.ingest({ schema_version: EVENTS_VERSION, events });
  const sos = event("sos.opened", { need: "general", source: "touch" });
  const open = () => {
    ingest(event("box.opened", {}), sos);
    return network.openIncidentForBox(box_id)!.incident.incident_id;
  };
  return { network, worker, pushes, ingest, sos, open };
}

describe("simulated caller fact worker", () => {
  it("starts independently, waits briefly for context, and labels configured address", () => {
    const t = setup();
    const incidentId = t.open();
    expect(t.worker.pendingForBox(box_id)).toBeNull();
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } }));
    expect(t.worker.state(incidentId)).toMatchObject({ task_id: t.sos.event_id, pending: "situation", location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } });
    expect(t.worker.pendingForBox(box_id)).toMatchObject({ type: "emergency.question", question_id: "situation", task_id: t.sos.event_id });
    t.worker.stop();
  });

  it("does not ask for a people count when the situation and location are already known", () => {
    const t = setup();
    t.ingest(event("box.opened", {}), event("report.heard", { text: "I have a cut on my arm." }), t.sos);
    const incidentId = t.network.openIncidentForBox(box_id)!.incident.incident_id;
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } }));
    expect(t.worker.state(incidentId)).toMatchObject({ pending: null, ready: true });
    expect(t.pushes).not.toContainEqual(expect.objectContaining({ type: "emergency.question" }));
    t.worker.stop();
  });

  it("accepts only the pending question with exact same-session report provenance", () => {
    const t = setup();
    const incidentId = t.open();
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } }));
    const report = event("report.heard", { text: "Someone fell and hurt their arm." });
    t.ingest(event("emergency.answer", { task_id: t.sos.event_id, question_id: "situation", answer: report.text, source_event_id: report.event_id }));
    expect(t.worker.state(incidentId)?.pending).toBe("situation");
    t.ingest(report, event("emergency.answer", { task_id: t.sos.event_id, question_id: "people_count", answer: report.text, source_event_id: report.event_id }));
    expect(t.worker.state(incidentId)?.pending).toBe("situation");
    t.ingest(event("emergency.answer", { task_id: t.sos.event_id, question_id: "situation", answer: "Different words", source_event_id: report.event_id }));
    expect(t.worker.state(incidentId)?.pending).toBe("situation");
    t.ingest(event("emergency.answer", { task_id: t.sos.event_id, question_id: "situation", answer: report.text, source_event_id: report.event_id }));
    expect(t.worker.state(incidentId)).toMatchObject({ pending: null, ready: true });
    t.ingest(event("emergency.answer", { task_id: t.sos.event_id, question_id: "people_count", answer: report.text, source_event_id: report.event_id }));
    expect(t.worker.state(incidentId)).toMatchObject({ pending: null, ready: true });
    expect(t.pushes).not.toContainEqual(expect.objectContaining({ type: "emergency.question", question_id: "people_count" }));
    t.worker.stop();
  });

  it("asks for location only when unavailable and ignores unrelated utterances", () => {
    const t = setup();
    const incidentId = t.open();
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "unavailable" } }));
    const answer = (question_id: "situation" | "people_count" | "location", text: string) => {
      const report = event("report.heard", { text });
      t.ingest(report, event("emergency.answer", { task_id: t.sos.event_id, question_id, answer: text, source_event_id: report.event_id }));
    };
    answer("situation", "Someone fell near the stairs.");
    expect(t.worker.state(incidentId)?.pending).toBe("location");
    expect(t.pushes).not.toContainEqual(expect.objectContaining({ type: "emergency.question", question_id: "people_count" }));
    answer("location", "Where is the gauze");
    expect(t.worker.state(incidentId)?.pending).toBe("location");
    answer("location", "Near the north entrance");
    expect(t.worker.state(incidentId)?.ready).toBe(true);
    t.worker.stop();
  });

  it("cancels without blocking responder alerts and replays the pending question after restart", () => {
    const t = setup();
    const incidentId = t.open();
    expect(t.network.openIncidentForBox(box_id)?.incident.alerts.length).toBeGreaterThan(0);
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } }));
    const saved = t.worker.exportState();
    t.worker.stop();
    const pushes: BoxPush[] = [];
    const resumed = createEmergencyWorker({ network: t.network, restored: saved, emit: (change) => pushes.push(change.push) });
    expect(resumed.pendingForBox(box_id)).toMatchObject({ type: "emergency.question", question_id: "situation" });
    t.ingest(event("sos.cancelled", { source: "touch" }));
    expect(resumed.pendingForBox(box_id)).toBeNull();
    expect(pushes).toContainEqual(expect.objectContaining({ type: "emergency.status", incident_id: incidentId, state: "cancelled" }));
    resumed.stop();
  });

  it("falls back to text when synthesized speech would exceed the Pi event-stream limit", async () => {
    const t = setup();
    t.worker.stop();
    const pushes: BoxPush[] = [];
    const worker = createEmergencyWorker({
      network: t.network,
      emit: (change) => pushes.push(change.push),
      speak: async () => ({ mime: "audio/wav", sample_rate: 16_000, data_base64: "A".repeat(190_000) }),
    });
    t.open();
    t.ingest(event("emergency.context", { task_id: t.sos.event_id, location: { kind: "configured_address", address: "Julis Romo Rabinowitz Building, 20 Washington Road, Princeton, NJ 08544" } }));
    await vi.waitFor(() => expect(worker.pendingForBox(box_id)).toMatchObject({ type: "emergency.question" }));
    const push = worker.pendingForBox(box_id);
    expect(push).not.toHaveProperty("speech");
    expect(JSON.stringify(push).length).toBeLessThan(256 * 1024);
    worker.stop();
  });
});

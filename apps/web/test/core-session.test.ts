import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVENTS_VERSION, VOICE_TURN_VERSION, type TurnRequest, type TurnResponse } from "@clara/contracts";
import { createNetwork } from "@clara/network";
import { createCoreSessionBook } from "../lib/core-session";
import { createEmergencyWorker } from "../lib/emergency";

const at = "2026-11-13T20:00:00.000Z";
const session_id = randomUUID();
const box_id = "box-clinic";
const state: TurnRequest["state"] = { scenario_id: null, step_id: null, allowed_steps: [], questions: [], manifest: [{ sku: "SCISSORS", name: "scissors", on_hand: 1 }], triage_available: false, recent_turns: [] };
const request = (id = randomUUID()): TurnRequest => ({ schema_version: VOICE_TURN_VERSION, client_turn_id: id, session_id, language: "en", input: { type: "text", text: "Where are the scissors?" }, state });

describe("Core Clara session context", () => {
  it("keeps one camera description only briefly in its own lid session", () => {
    let time = Date.parse(at);
    const network = createNetwork();
    network.seedDemo();
    const emergency = createEmergencyWorker({ network, emit: () => {} });
    const book = createCoreSessionBook(network, emergency, () => time);
    book.prepare(box_id, request());
    book.recordCamera(box_id, session_id, { captured_at: at, observed_at: at, description: "A red line is visible on one finger." });
    expect(book.prepare(box_id, request()).state.core_context?.camera?.description).toContain("red line");
    expect(book.prepare(box_id, { ...request(), session_id: randomUUID() }).state.core_context?.camera).toBeNull();
    time += 121_000;
    expect(book.prepare(box_id, request()).state.core_context?.camera).toBeNull();
    emergency.stop();
  });
  it("reconstructs a source-labeled older report after the Pi's recent turns are empty", () => {
    const network = createNetwork();
    network.seedDemo();
    const reportId = randomUUID();
    network.ingest({ schema_version: EVENTS_VERSION, events: [{ event_id: reportId, box_id, session_id, occurred_at: at, type: "report.heard", text: "A person fell near the box." }] });
    const emergency = createEmergencyWorker({ network, emit: () => {} });
    const book = createCoreSessionBook(network, emergency, () => Date.parse(at));
    const first = request();
    const prepared = book.prepare(box_id, first);
    expect(prepared.state.core_context?.reports).toEqual([{ source_event_id: reportId, at, text: "A person fell near the box." }]);
    expect(prepared.state.core_context?.camera).toBeNull();
    book.recordCamera(box_id, session_id, { captured_at: at, observed_at: at, description: "A hand is near the camera. A red line is visible on one finger." });
    expect(book.prepare(box_id, request()).state.core_context?.camera?.description).toContain("red line");
    const response: TurnResponse = { schema_version: VOICE_TURN_VERSION, client_turn_id: first.client_turn_id, heard: "Where are the scissors?", reply: "The screen shows the location.", action: { name: "locate_item", sku: "SCISSORS" }, answered_by: "model", reason: null, speech: null };
    book.finish(box_id, prepared, response);
    const second = book.prepare(box_id, request());
    expect(second.state.recent_turns).toEqual([{ from: "person", words: "Where are the scissors?" }, { from: "clara", words: "The screen shows the location." }]);
    expect(second.state.core_context?.actions).toMatchObject([{ name: "locate_item", id: "SCISSORS", status: "requested" }]);
    expect(book.cached(box_id, first)).toEqual(response);
    emergency.stop();
  });

  it("does not retain a cancelled turn or a forged box-supplied core context", () => {
    const network = createNetwork();
    network.seedDemo();
    const emergency = createEmergencyWorker({ network, emit: () => {} });
    const book = createCoreSessionBook(network, emergency, () => Date.parse(at));
    const first = request();
    const prepared = book.prepare(box_id, { ...first, state: { ...state, core_context: { reports: [], actions: [], emergency_task: null, camera: null } } });
    expect(prepared.state.core_context).toEqual({ reports: [], actions: [], emergency_task: null, camera: null });
    book.finish(box_id, prepared, { schema_version: VOICE_TURN_VERSION, client_turn_id: first.client_turn_id, heard: "private", reply: "reply", action: null, answered_by: "model", reason: null, speech: null }, true);
    expect(book.prepare(box_id, request()).state.recent_turns).toEqual([]);
    emergency.stop();
  });
});

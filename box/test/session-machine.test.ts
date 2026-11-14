import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Alert } from "@clara/contracts";
import { FakeCloudLink } from "../src/cloud/fake.js";
import { loadKit, loadScenario } from "../src/engine/index.js";
import type { Board, BoardEvent, SpeechQueue } from "../src/ports.js";
import { BoxSession, ManualClock, textTurn } from "../src/session/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

class FakeBoard implements Board {
  readonly label = "fake";
  readonly simulated = true;
  calls: string[] = [];
  private listeners: ((e: BoardEvent) => void)[] = [];
  onEvent(listener: (e: BoardEvent) => void) {
    this.listeners.push(listener);
  }
  emit(e: BoardEvent) {
    for (const l of this.listeners) l(e);
  }
  lid(open: boolean) {
    this.emit({ t: "lid", open, seq: 0 });
  }
  async lightCompartment(ch: number) {
    this.calls.push(`light ${ch}`);
    return true;
  }
  async clearLights() {
    this.calls.push("clear");
    return true;
  }
  async rhythm(bpm: number) {
    this.calls.push(`rhythm ${bpm}`);
    return true;
  }
  async buzz(p: string) {
    this.calls.push(`buzz ${p}`);
    return true;
  }
  async startPulse() {
    return true;
  }
  async stopPulse() {
    return true;
  }
  async close() {}
}

class FakeSpeech implements SpeechQueue {
  said: string[] = [];
  stops = 0;
  busy = false;
  async say(item: { text: string }) {
    this.said.push(item.text);
  }
  stopAll() {
    this.stops += 1;
  }
  onIdle() {}
  onBusy() {}
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function setup() {
  const clock = new ManualClock();
  const cloud = new FakeCloudLink();
  const board = new FakeBoard();
  const speech = new FakeSpeech();
  const session = new BoxSession({
    boxId: "box-test",
    boxName: "Test Box",
    scenario: loadScenario(fixture("test-scenario.json")),
    kit: loadKit(fixture("test-kit.json")),
    cloud,
    board,
    speech,
    clock,
    newId: uuid,
  });
  return { clock, cloud, board, speech, session };
}

const alert = (state: Alert["state"], name = "Amina", eta: number | null = 6): Alert => ({
  alert_id: "a1",
  incident_id: "i1",
  volunteer_id: "v1",
  volunteer_name: name,
  state,
  eta_minutes: eta,
  sent_at: "2026-11-13T10:00:00.000Z",
  updated_at: "2026-11-13T10:00:00.000Z",
});

describe("BoxSession lid", () => {
  it("lid open enables conversation without requesting or showing guidance", async () => {
    const { session, cloud, board, speech } = setup();
    expect(session.view().phase).toBe("idle");
    board.lid(true);
    await Promise.resolve();
    expect(session.active).toBe(true);
    expect(cloud.types()).toEqual(["box.opened"]);
    expect(cloud.events.every((e) => e.session_id === session.sessionId)).toBe(true);
    expect(board.calls).toContain("buzz chime");
    expect(board.calls).not.toContain("light 0");
    expect(speech.said).toEqual([]);
    const view = session.view();
    expect(view.phase).toBe("guiding");
    expect(view.step).toBeNull();
    expect(session.turnState()?.allowed_steps.map((s) => s.step_id)).toEqual(["s1"]);
    expect(session.applyAction({ name: "select_step", step_id: "s1" })).toBe(true);
    expect(session.view().step?.item).toMatchObject({ slot: "A1", lit: true });
    expect(session.view().step?.image_url).toBe("/content/images/test-one.png");
    expect(session.view().presentation).toMatchObject({ kind: "guidance", body: session.view().step?.text, image_url: session.view().step?.image_url });
    expect(speech.said[0]).toContain("TEST PLACEHOLDER 1");
  });

  it("ignores a repeated lid-open and ends the session on lid close", () => {
    const { session, cloud, board } = setup();
    board.lid(true);
    const id = session.sessionId;
    board.lid(true);
    expect(session.sessionId).toBe(id);
    board.lid(false);
    expect(session.active).toBe(false);
    expect(cloud.types().at(-1)).toBe("box.closed");
    expect(cloud.events.at(-1)?.session_id).toBe(id);
    expect(session.view().phase).toBe("idle");
    expect(session.view().step).toBeNull();
  });

  it("keeps the mic off for closed-lid SOS, then starts it when the lid opens", () => {
    const { session } = setup();
    let starts = 0;
    let stops = 0;
    session.attachVoice({ handsFree: true, start: () => starts++, stop: () => stops++, pressTalk: () => {} });
    session.press({ action: "sos" });
    const id = session.sessionId;
    expect(session.view()).toMatchObject({ lid_open: false, voice_available: false });
    expect(session.turnState()).toBeNull();
    session.press({ action: "talk" });
    expect(starts).toBe(0);
    session.lidOpened();
    expect(session.sessionId).toBe(id);
    expect(session.view()).toMatchObject({ lid_open: true, voice_available: true });
    expect(starts).toBe(1);
    session.lidClosed();
    expect(stops).toBe(1);
  });

  it("does not label a press-only microphone as hands-free", () => {
    const { session } = setup();
    session.attachVoice({ handsFree: false, start: () => {}, stop: () => {}, pressTalk: () => {} });
    session.lidOpened();
    expect(session.view().voice_available).toBe(false);
  });
});

describe("BoxSession SOS", () => {
  it("counts down 5 s, then opens the mock 911 screen", () => {
    const { session, cloud, clock, speech } = setup();
    session.lidOpened();
    session.press({ action: "sos" });
    expect(session.view().phase).toBe("countdown");
    expect(session.view().countdown?.seconds_left).toBe(5);
    clock.advance(2_000);
    expect(session.view().countdown?.seconds_left).toBe(3);
    clock.advance(3_000);
    const view = session.view();
    expect(view.phase).toBe("sos");
    expect(view.sos?.coaching.join(" ")).toContain("Test Box");
    expect(cloud.types()).toContain("sos.countdown");
    expect(cloud.events.find((e) => e.type === "sos.opened")).toMatchObject({ need: "general", source: "touch" });
    expect(speech.said.join(" ")).toMatch(/simulated 911 call\. No real call/i);
    // Nothing may promise help before an accept.
    expect(speech.said.join(" ").toLowerCase()).not.toContain("is coming");
    session.press({ action: "hide_911" });
    expect(session.view().phase).toBe("guiding");
    session.press({ action: "sos" });
    expect(session.view().phase).toBe("sos");
    expect(cloud.types().filter((t) => t === "sos.opened")).toHaveLength(1);
  });

  it("cancels the countdown", () => {
    const { session, cloud, clock } = setup();
    session.lidOpened();
    session.press({ action: "sos" });
    clock.advance(2_500);
    session.press({ action: "cancel_sos" });
    clock.advance(10_000);
    expect(session.view().phase).toBe("guiding");
    expect(cloud.types()).toContain("sos.cancelled");
    expect(cloud.types()).not.toContain("sos.opened");
  });

  it("SOS works from idle without the lid or the network", () => {
    const { session, cloud, clock } = setup();
    cloud.setOnline(false);
    session.press({ action: "sos" });
    clock.advance(5_000);
    expect(session.view().phase).toBe("sos");
    expect(session.view().online).toBe(false);
    expect(cloud.types()).toEqual(["box.opened", "sos.countdown", "sos.opened"]);
  });

  it("a step marked sos opens the countdown", () => {
    const { session } = setup();
    session.lidOpened();
    session.applyAction({ name: "select_step", step_id: "s1" });
    session.press({ action: "goto", step_id: "s3" });
    expect(session.view().phase).toBe("countdown");
  });

  it("closing the lid during the countdown cancels it", () => {
    const { session, cloud, clock } = setup();
    session.lidOpened();
    session.press({ action: "sos" });
    session.lidClosed();
    clock.advance(10_000);
    expect(cloud.types().slice(-2)).toEqual(["sos.cancelled", "box.closed"]);
    expect(session.view().phase).toBe("idle");
  });
});

describe("BoxSession pushes", () => {
  it("says who is coming only through comingLine, after an accept", () => {
    const { session, cloud, speech } = setup();
    session.lidOpened();
    cloud.push({ type: "alert.update", incident_id: "i1", alert: alert("sent") });
    expect(session.view().coming).toBeNull();
    cloud.push({ type: "alert.update", incident_id: "i1", alert: alert("coming") });
    expect(session.view().coming).toBe("Amina is coming, about 6 minutes.");
    expect(speech.said.at(-1)).toBe("Amina is coming, about 6 minutes.");
    cloud.push({ type: "alert.update", incident_id: "i1", alert: alert("declined") });
    expect(session.view().coming).toBeNull();
    expect(speech.said.at(-1)).not.toContain("coming,");
  });

  it("reads a responder message aloud", () => {
    const { session, cloud, speech } = setup();
    session.lidOpened();
    cloud.push({ type: "responder.message", incident_id: "i1", from: "Amina", text: "Two minutes away" });
    expect(speech.said.at(-1)).toBe("Message from Amina: Two minutes away");
    expect(session.view().messages).toHaveLength(1);
  });

  it("ignores alerts with no session", () => {
    const { session, cloud } = setup();
    cloud.push({ type: "alert.update", incident_id: "i1", alert: alert("coming") });
    expect(session.view().coming).toBeNull();
  });

  it("shows another box's emergency, full screen when idle, and clears it", () => {
    const { session, cloud, board } = setup();
    cloud.push({ type: "nearby.emergency", incident_id: "i9", from_box_id: "box-a", from_box_name: "Room 101", directions: "Ground floor" });
    expect(session.view().nearby).toHaveLength(1);
    expect(session.view().phase).toBe("idle");
    expect(board.calls).toContain("buzz alert");
    session.press({ action: "bringing_kit", incident_id: "i9" });
    expect(session.view().nearby[0]?.bringing).toBe(true);
    cloud.push({ type: "nearby.clear", incident_id: "i9" });
    expect(session.view().nearby).toHaveLength(0);
  });

  it("ignores its own emergency echoed back", () => {
    const { session, cloud } = setup();
    cloud.push({ type: "nearby.emergency", incident_id: "i9", from_box_id: "box-test", from_box_name: "Me", directions: "" });
    expect(session.view().nearby).toHaveLength(0);
  });

  it("tracks online state", () => {
    const { session, cloud } = setup();
    cloud.setOnline(false);
    expect(session.view().online).toBe(false);
  });
});

describe("BoxSession actions", () => {
  it("shows an item request without starting a scenario step, then shows an answer", () => {
    const { session, board } = setup();
    session.lidOpened();
    expect(session.applyAction({ name: "locate_item", sku: "sku_a" })).toBe(true);
    expect(session.view().step).toBeNull();
    expect(session.view().presentation).toMatchObject({ kind: "item", title: "Test item A", body: "Listed in compartment A1.", source_label: "Demo kit manifest", item: { slot: "A1", lit: true } });
    expect(board.calls).toContain("light 0");
    session.showCaption("Here is the item.", false);
    expect(session.view().presentation?.kind).toBe("item");
    session.showCaption("Tell me more.");
    expect(session.view().presentation).toMatchObject({ kind: "answer", body: "Tell me more." });
  });

  it("refuses an action not allowed now", () => {
    const { session } = setup();
    session.lidOpened();
    expect(session.applyAction({ name: "select_step", step_id: "s5" })).toBe(false);
    expect(session.applyAction({ name: "start_triage" })).toBe(false);
    expect(session.applyAction({ name: "record_usage", items: [{ sku: "sku_a", qty: 9 }] })).toBe(false);
    expect(session.view().step).toBeNull();
  });

  it("changes supply counts only after a confirm tap", () => {
    const { session, cloud } = setup();
    session.lidOpened();
    expect(session.applyAction({ name: "record_usage", items: [{ sku: "sku_a", qty: 1 }] })).toBe(true);
    expect(session.engine.kit.get("sku_a")?.on_hand).toBe(2);
    expect(session.view().pending_usage).toEqual([{ sku: "sku_a", qty: 1, name: "Test item A" }]);
    session.press({ action: "confirm_usage" });
    expect(session.engine.kit.get("sku_a")?.on_hand).toBe(1);
    expect(cloud.events.find((e) => e.type === "supply.used")).toMatchObject({ sku: "sku_a", qty: 1, confirmed: true });
  });

  it("a typed turn moves to an allowed step and records what was heard", async () => {
    const { session, cloud } = setup();
    session.lidOpened();
    session.applyAction({ name: "select_step", step_id: "s1" });
    cloud.responder = (req) => ({
      schema_version: "voice-turn/0.1",
      client_turn_id: req.client_turn_id,
      heard: "step two",
      reply: "ok",
      action: { name: "select_step", step_id: "s2" },
      answered_by: "model",
      reason: null,
      speech: null,
    });
    const result = await textTurn(session, cloud, "step two", { newId: uuid });
    expect(result.ok).toBe(true);
    expect(session.view().step?.step_id).toBe("s2");
    expect(cloud.turns[0]?.state.allowed_steps.map((s) => s.step_id)).toEqual(["s1", "s2", "s3"]);
    expect(cloud.types()).toContain("report.heard");
  });

  it("a failed typed turn ends in a fixed line", async () => {
    const { session, cloud, speech } = setup();
    session.lidOpened();
    cloud.setOnline(false);
    const result = await textTurn(session, cloud, "hello", { newId: uuid });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(speech.said.at(-1)).toMatch(/can't reach the assistant/);
  });

  it("Talk without a voice loop says so", () => {
    const { session, speech } = setup();
    session.lidOpened();
    session.press({ action: "talk" });
    expect(speech.said.at(-1)).toMatch(/Voice is not available/);
  });

  it("sends a heartbeat on its interval", () => {
    const { session, cloud, clock } = setup();
    session.startHeartbeat(30_000, () => ["screen"]);
    clock.advance(60_000);
    expect(cloud.types().filter((t) => t === "box.heartbeat")).toHaveLength(3);
    session.close();
  });
});

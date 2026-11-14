import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoxEvent } from "@clara/contracts";
import { FakeCloudLink } from "../src/cloud/fake.js";
import { loadKit, loadScenario } from "../src/engine/index.js";
import type { Board, BoardEvent, SpeechQueue, Utterance } from "../src/ports.js";
import { BoxSession, ManualClock } from "../src/session/index.js";
import { CPR_PROMPT, PROMPT_EVERY_MS, tickSegment } from "../src/session/coach.js";
import { buildHandoffSummary } from "../src/session/summary.js";

const content = (name: string) => fileURLToPath(new URL(`../../content/${name}`, import.meta.url));

class FakeBoard implements Board {
  readonly label = "fake";
  readonly simulated = true;
  calls: string[] = [];
  private listeners: ((e: BoardEvent) => void)[] = [];
  onEvent(listener: (e: BoardEvent) => void) {
    this.listeners.push(listener);
  }
  lid(open: boolean) {
    for (const l of this.listeners) l({ t: "lid", open, seq: 0 });
  }
  emit(e: BoardEvent) {
    for (const l of this.listeners) l(e);
  }
  finger() {
    this.emit({ t: "sensor.raw", id: 1, seq: 0, sample_seq: 0, sampled_uptime_ms: 0, red: 60_000, ir: 80_000, quality: "valid" });
  }
  noPulse() {
    this.emit({ t: "pulse", bpm: null, quality: "unavailable", seq: 0 });
  }
  async lightCompartment(ch: number) {
    this.calls.push(`light ${ch}`);
    return true;
  }
  async clearLights() {
    this.calls.push("clear");
    return true;
  }
  async rhythm(bpm: number, pattern?: string) {
    this.calls.push(`rhythm ${bpm}${pattern ? ` ${pattern}` : ""}`);
    return true;
  }
  async buzz() {
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
  busy = false;
  muted = false;
  private busyL: (() => void)[] = [];
  private idleL: (() => void)[] = [];
  async say(item: { text: string }) {
    this.said.push(item.text);
  }
  setMuted(m: boolean) {
    this.muted = m;
  }
  stopAll() {}
  onIdle(l: () => void) {
    this.idleL.push(l);
  }
  onBusy(l: () => void) {
    this.busyL.push(l);
  }
  startLine() {
    this.busy = true;
    for (const l of this.busyL) l();
  }
  endLine() {
    this.busy = false;
    for (const l of this.idleL) l();
  }
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function setup() {
  const clock = new ManualClock();
  const cloud = new FakeCloudLink();
  const board = new FakeBoard();
  const speech = new FakeSpeech();
  const segments: { wav: Buffer; stopped: boolean }[] = [];
  const tick = (wav: Buffer): Utterance => {
    const seg = { wav, stopped: false };
    segments.push(seg);
    return { done: new Promise(() => {}), stop: () => void (seg.stopped = true) };
  };
  const session = new BoxSession({
    boxId: "box-test",
    scenario: loadScenario(content("scenarios/severe-bleeding.json")),
    scenarios: [loadScenario(content("scenarios/not-breathing.json"))],
    kit: loadKit(content("kits/clara-3slot-v1.json")),
    cloud,
    board,
    speech,
    tick,
    clock,
    newId: uuid,
  });
  return { clock, cloud, board, speech, session, segments };
}

/** Opens the lid, picks Not breathing, and steps to the compressions step. */
function toCompressions(s: ReturnType<typeof setup>) {
  s.board.lid(true);
  s.session.press({ action: "pick_scenario", scenario_id: "not_breathing" });
  s.session.press({ action: "cancel_sos" }); // get_help opens the countdown on the way; not under test here
  while (s.session.view().step?.step_id !== "compressions") s.session.next("touch");
}

describe("not-breathing scenario", () => {
  it("validates, is a draft, opens SOS, and coaches CPR at 110 bpm", () => {
    const scenario = loadScenario(content("scenarios/not-breathing.json"));
    expect(scenario.status).toBe("draft");
    expect(scenario.steps.find((s) => s.sos)?.step_id).toBe("get_help");
    expect(scenario.steps.find((s) => s.step_id === "compressions")?.coach).toEqual({ kind: "cpr", bpm: 110 });
    expect(scenario.steps.every((s) => !s.item)).toBe(true); // the default kit is not touched
  });
});

describe("CPR rhythm coach", () => {
  it("starts the LED beat and ticks on a coach step, keeps them across coached steps, and stops on a step change", () => {
    const s = setup();
    toCompressions(s);
    expect(s.board.calls).toContain("rhythm 110 beat");
    expect(s.segments).toHaveLength(1);
    expect(s.session.view().coach).toMatchObject({ kind: "cpr", bpm: 110 });

    s.session.next("touch"); // keep_going: same rate, beat continues
    expect(s.board.calls.filter((c) => c.startsWith("rhythm 110"))).toHaveLength(1);
    expect(s.segments[0]!.stopped).toBe(false);

    s.session.back("touch"); // compressions again: still coached
    s.session.back("touch"); // hand_position: not coached
    expect(s.board.calls.at(-1) === "rhythm 0" || s.board.calls.includes("rhythm 0")).toBe(true);
    expect(s.segments[0]!.stopped).toBe(true);
    expect(s.session.view().coach).toBeNull();
  });

  it("pauses ticks while a line is spoken, says the fixed prompt every 20 s, and stops on lid close", () => {
    const s = setup();
    toCompressions(s);
    s.speech.startLine();
    expect(s.segments[0]!.stopped).toBe(true);
    s.speech.endLine();
    expect(s.segments).toHaveLength(2);

    s.clock.advance(PROMPT_EVERY_MS);
    expect(s.speech.said.at(-1)).toBe(CPR_PROMPT);
    expect(s.segments[1]!.stopped).toBe(true);

    s.board.lid(false);
    expect(s.board.calls.at(-1)).toBe("rhythm 0");
    expect(s.session.view().coach).toBeNull();
    const said = s.speech.said.length;
    s.clock.advance(PROMPT_EVERY_MS * 2);
    expect(s.speech.said.length).toBe(said);
  });

  it("stops on the Stop press", () => {
    const s = setup();
    toCompressions(s);
    s.session.press({ action: "stop_coach" });
    expect(s.board.calls.at(-1)).toBe("rhythm 0");
    expect(s.segments[0]!.stopped).toBe(true);
  });

  it("switches to the CPR scenario when the bystander says they are not breathing", () => {
    const s = setup();
    s.board.lid(true);
    s.session.heard("Help, he's not breathing!");
    expect(s.session.view().scenario_id).toBe("not_breathing");
    expect(s.session.view().step?.step_id).toBe("check_response");
    s.session.heard("he isn't breathing still");
    expect(s.session.view().step?.step_id).toBe("check_response"); // no restart once switched
  });

  it("renders ticks on an exact beat grid", () => {
    const wav = tickSegment(100, 60_000 / 110, 2_000)!;
    const samples = (wav.length - 44) / 2;
    // 4 beats start before 2 s (0, 545, 1091, 1636 ms after the lead-in) and the last tick ends the segment.
    expect(samples).toBe(Math.round(((100 + 3 * (60_000 / 110)) / 1000) * 16_000) + 560);
    expect(tickSegment(0, 545, 0)).toBeNull();
  });
});

describe("scene report on the box", () => {
  it("shows the short paramedic link after the server's incident.opened push, and drops it on lid close", () => {
    const s = setup();
    s.board.lid(true);
    s.session.requestSos("touch");
    s.clock.advance(6_000);
    s.cloud.push({ type: "incident.opened", incident_id: "inc_1", report_url: "https://clara.living/report/abcdef0123456789", report_code: "AB12CD" });
    expect(s.session.view().report_link).toBe("clara.living/r/AB12CD");
    expect(s.session.view().report_url).toBe("https://clara.living/report/abcdef0123456789");
    s.board.lid(false);
    expect(s.session.view().report_link).toBeNull();
    s.cloud.push({ type: "incident.opened", incident_id: "inc_1", report_url: "https://clara.living/report/abcdef0123456789", report_code: "AB12CD" });
    expect(s.session.view().report_link).toBeNull(); // no session: ignored
  });

  it("reads a handoff summary built only from the session's own events, offline and without a link", () => {
    const s = setup();
    s.cloud.setOnline(false);
    s.board.lid(true);
    s.session.heard("He cut his leg on glass and it is bleeding a lot");
    s.session.start("touch");
    s.session.next("touch"); // safety
    s.session.next("touch"); // get_help (opens the countdown)
    s.clock.advance(6_000); // SOS opens
    s.session.press({ action: "read_summary" });
    const view = s.session.view();
    expect(view.presentation?.kind).toBe("handoff");
    const body = view.presentation!.body;
    expect(body).toContain('Reported by bystander: "He cut his leg on glass and it is bleeding a lot"');
    expect(body).toContain("Simulated SOS opened at");
    expect(body).toContain("Check it is safe and put on gloves at");
    expect(body).not.toMatch(/tourniquet|pulse/i);
    expect(s.speech.said.at(-1)).toBe(`Handoff summary. ${body.split("\n").join(" ")}`);
  });

  it("builds summary lines from events alone, with fixed templates", () => {
    const at = (min: number) => `2026-11-13T19:${String(min).padStart(2, "0")}:00.000Z`;
    const base = { box_id: "b", session_id: "00000000-0000-4000-8000-000000000001" };
    const events = [
      { ...base, event_id: "00000000-0000-4000-8000-0000000000a1", occurred_at: at(1), type: "step.shown", scenario_id: "severe_bleeding", step_id: "tourniquet", source: "touch" },
      { ...base, event_id: "00000000-0000-4000-8000-0000000000a2", occurred_at: at(2), type: "timer.started", timer: "tourniquet", step_id: "tourniquet" },
      { ...base, event_id: "00000000-0000-4000-8000-0000000000a3", occurred_at: at(3), type: "sensor.pulse", bpm: 96, quality: "valid" },
      { ...base, event_id: "00000000-0000-4000-8000-0000000000a4", occurred_at: at(4), type: "sensor.pulse", bpm: null, quality: "unavailable" },
    ] as BoxEvent[];
    const time = (iso: string) => iso.slice(11, 16);
    expect(buildHandoffSummary(events, { time, stepLabel: () => "Tourniquet" }).lines).toEqual([
      "Reported: nothing recorded.",
      "Steps guided on the box: Tourniquet at 19:01.",
      "Tourniquet time: 19:02.",
      "Device pulse reading: 96 per minute at 19:03.",
    ]);
    expect(buildHandoffSummary([], { time }).lines).toEqual(["Reported: nothing recorded.", "Steps guided: none recorded."]);
  });
});

describe("pulse sensor as a prompt, never the decision", () => {
  const NO_PULSE_LINE = "I can't detect a pulse. Is the person responding? Are they breathing normally?";

  it("a no-pulse reading with the clip on prompts and records a device reading, but does not start the coach", () => {
    const s = setup();
    s.board.lid(true);
    s.board.noPulse(); // no finger seen: no prompt
    expect(s.session.view().pulse_prompt).toBe(false);
    s.board.finger();
    s.board.noPulse();
    expect(s.session.view().pulse_prompt).toBe(true);
    expect(s.speech.said.at(-1)).toBe(NO_PULSE_LINE);
    expect(s.session.view().coach).toBeNull();
    expect(s.board.calls.some((c) => c.startsWith("rhythm 110"))).toBe(false);
    expect(s.session.view().step).toBeNull();
    expect(s.cloud.events.some((e) => e.type === "sensor.pulse" && e.bpm === null)).toBe(true);
  });

  it("NOT BREATHING starts the CPR coach step and the SOS countdown", () => {
    const s = setup();
    s.board.lid(true);
    s.board.finger();
    s.board.noPulse();
    s.session.press({ action: "pulse_not_breathing" });
    const v = s.session.view();
    expect(v.scenario_id).toBe("not_breathing");
    expect(v.step?.step_id).toBe("compressions");
    expect(v.coach).toMatchObject({ bpm: 110 });
    expect(v.phase).toBe("guiding");
    expect(s.board.calls).toContain("rhythm 110 beat");
    expect(v.pulse_prompt).toBe(false);
  });

  it("a spoken 'not breathing' answers the prompt the same way", () => {
    const s = setup();
    s.board.lid(true);
    s.board.finger();
    s.board.noPulse();
    s.session.heard("no, he's not breathing");
    expect(s.session.view().step?.step_id).toBe("compressions");
  });

  it("BREATHING dismisses and re-prompts at most once a minute", () => {
    const s = setup();
    s.board.lid(true);
    s.board.finger();
    s.board.noPulse();
    s.session.press({ action: "pulse_breathing" });
    expect(s.session.view().pulse_prompt).toBe(false);
    expect(s.session.view().coach).toBeNull();
    s.clock.advance(30_000);
    s.board.finger();
    s.board.noPulse();
    expect(s.session.view().pulse_prompt).toBe(false);
    s.clock.advance(31_000);
    s.board.finger();
    s.board.noPulse();
    expect(s.session.view().pulse_prompt).toBe(true);
  });

  it("CPR stays reachable with no sensor: picker, voice, and the SOS step", () => {
    const s = setup();
    toCompressions(s);
    expect(s.session.view().coach).not.toBeNull();
  });
});

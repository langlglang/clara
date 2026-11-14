import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BoxEvent } from "@clara/contracts";
import { EventFactory, Kit, ScenarioEngine, loadKit, loadScenario, parseScenario } from "../src/engine/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const content = (name: string) => fileURLToPath(new URL(`../../content/${name}`, import.meta.url));

function setup() {
  const events: BoxEvent[] = [];
  const factory = new EventFactory("box-test", () => 1_700_000_000_000);
  factory.sessionId = "00000000-0000-4000-8000-000000000001";
  const engine = new ScenarioEngine(loadScenario(fixture("test-scenario.json")), loadKit(fixture("test-kit.json")), {
    events: factory,
    emit: (e) => events.push(e),
    now: () => 1_700_000_000_000,
  });
  return { engine, events, types: () => events.map((e) => e.type) };
}

describe("scenario loading", () => {
  it("binds the minor-cut demo wording and sequence art to a stocked bandage", () => {
    const scenario = loadScenario(content("scenarios/minor-cut.json"));
    const kit = loadKit(content("kits/clara-3slot-v1.json"));
    const step = scenario.steps[0]!;
    expect(scenario).toMatchObject({ scenario_id: "minor_cut", version: "minor-cut-demo-v1", status: "draft", start: "rinse_cover" });
    expect(step).toMatchObject({ step_id: "rinse_cover", item: "ADHESIVE_BANDAGES", image: "visuals/minor-cut-sequence-v1.svg" });
    expect(step.text).toMatch(/running tap water or sterile saline.*adhesive bandage/i);
    expect(step.text).toMatch(/if running tap water or sterile saline is available/i);
    expect(step.text).not.toMatch(/antiseptic|alcohol/i);
    expect(kit.get(step.item!)?.on_hand).toBeGreaterThan(0);
    expect(kit.get("WATER")).toBeNull();
    expect(existsSync(content(step.image!))).toBe(true);
  });
  it("maps every stocked item to one of the three physically verified compartments", () => {
    const kit = loadKit(content("kits/clara-3slot-v1.json"));
    expect(kit.kitId).toBe("clara-3slot-v1");
    expect(kit.layoutRevision).toBe("3slot-v1");
    expect(kit.all()).toHaveLength(22);
    const mapping = { "top-left": 0, "top-right": 1, bottom: 2 } as const;
    for (const item of kit.all()) {
      expect(item.led).toBe(mapping[item.slot as keyof typeof mapping]);
    }
    expect(kit.get("SCISSORS")?.slot).toBe("top-left");
    expect(kit.get("GLOVES")?.slot).toBe("top-right");
    expect(kit.get("GAUZE")?.slot).toBe("bottom");
    expect(kit.get("POPSICLE_STICKS")?.slot).toBe("bottom");
  });

  it("loads and checks the fixture", () => {
    const scenario = loadScenario(fixture("test-scenario.json"));
    expect(scenario.steps).toHaveLength(5);
  });

  it("rejects a next that names no step", () => {
    const bad = { scenario_id: "x", version: "1", title: "t", status: "draft", sources: ["https://example.org"], start: "a", steps: [{ step_id: "a", label: "a", text: "a", next: ["zz"] }], questions: [], triage_available: false };
    expect(() => parseScenario(bad)).toThrow(/unknown step/);
  });

  it("rejects a kit with two items on one LED", () => {
    expect(() => new Kit([
      { sku: "a", name: "a", slot: "A1", led: 1, on_hand: 1, low_at: 0 },
      { sku: "b", name: "b", slot: "A2", led: 1, on_hand: 1, low_at: 0 },
    ])).toThrow(/LED/);
  });
});

describe("ScenarioEngine", () => {
  it("does not offer guidance that requires absent equipment", () => {
    const events = new EventFactory("box-test", () => 1_700_000_000_000);
    events.sessionId = "00000000-0000-4000-8000-000000000001";
    const engine = new ScenarioEngine(loadScenario(content("scenarios/severe-bleeding.json")), loadKit(content("kits/clara-3slot-v1.json")), {
      events, emit: () => {},
    });
    engine.start("voice");
    engine.goTo("safety", "voice");
    engine.goTo("get_help", "voice");
    engine.goTo("find_wound", "voice");
    expect(engine.turnState().allowed_steps.map((step) => step.step_id)).toEqual(["find_wound", "direct_pressure"]);
  });

  it("offers only the entry package before guidance starts", () => {
    const { engine } = setup();
    expect(engine.turnState().allowed_steps.map((s) => s.step_id)).toEqual(["s1"]);
    expect(engine.goTo("s2", "voice")).toBeNull();
    expect(engine.goTo("s1", "voice")?.[0]).toMatchObject({ kind: "show", replay: false });
  });

  it("starts at the first step, emits events and lights the step's compartment", () => {
    const { engine, events, types } = setup();
    const intents = engine.start("device");
    expect(engine.current?.step_id).toBe("s1");
    expect(types()).toEqual(["scenario.started", "step.shown"]);
    expect(intents).toContainEqual({ kind: "light", sku: "sku_a", slot: "A1", channel: 0, ms: 30_000 });
    expect(events.every((e) => e.box_id === "box-test" && e.session_id !== null)).toBe(true);
  });

  it("goes next, back and repeats", () => {
    const { engine, types } = setup();
    engine.start("touch");
    const next = engine.next("touch")!;
    expect(engine.current?.step_id).toBe("s2");
    expect(next.find((i) => i.kind === "start_timer")).toMatchObject({ timer: "pressure" });
    expect(next).toContainEqual({ kind: "clear_lights" });
    expect(types()).toContain("timer.started");
    expect(types()).toContain("step.done");
    engine.back("touch");
    expect(engine.current?.step_id).toBe("s1");
    expect(engine.canBack()).toBe(false);
    expect(engine.back("touch")).toBeNull();
    const repeat = engine.repeat()!;
    expect(repeat[0]).toMatchObject({ kind: "show", replay: true });
  });

  it("does not start a timer twice", () => {
    const { engine, types } = setup();
    engine.start("touch");
    engine.next("touch");
    engine.back("touch");
    engine.next("touch");
    expect(types().filter((t) => t === "timer.started")).toHaveLength(1);
  });

  it("allows goTo only for the current step's next steps", () => {
    const { engine } = setup();
    engine.start("voice");
    expect(engine.goTo("s5", "voice")).toBeNull();
    expect(engine.current?.step_id).toBe("s1");
    expect(engine.goTo("s3", "voice")).toContainEqual({ kind: "open_sos_countdown" });
    expect(engine.current?.step_id).toBe("s3");
  });

  it("does not light an item with none on hand", () => {
    const { engine } = setup();
    engine.start("touch");
    engine.goTo("s2", "touch");
    const intents = engine.next("touch")!;
    expect(intents).toContainEqual({ kind: "item_missing", sku: "sku_empty", name: "Test empty item" });
    expect(intents.some((i) => i.kind === "light")).toBe(false);
  });

  it("returns null past the last step", () => {
    const { engine } = setup();
    engine.start("touch");
    engine.goTo("s2", "touch");
    engine.next("touch");
    engine.next("touch");
    expect(engine.current?.step_id).toBe("s5");
    expect(engine.next("touch")).toBeNull();
  });

  it("builds the voice turn state from the current step", () => {
    const { engine } = setup();
    engine.start("voice");
    const state = engine.turnState([{ from: "person", words: "hello" }]);
    expect(state.step_id).toBe("s1");
    expect(state.allowed_steps.map((s) => s.step_id)).toEqual(["s1", "s2", "s3"]);
    expect(state.manifest).toContainEqual({ sku: "sku_a", name: "Test item A", on_hand: 2 });
    expect(state.questions).toHaveLength(1);
    expect(state.recent_turns).toHaveLength(1);
  });

  it("changes kit counts only within what is on hand", () => {
    const { engine } = setup();
    expect(engine.kit.use("sku_a", 3)).toBe(false);
    expect(engine.kit.use("nope", 1)).toBe(false);
    expect(engine.kit.use("sku_a", 1)).toBe(true);
    expect(engine.kit.get("sku_a")?.on_hand).toBe(1);
    expect(engine.kit.low().map((i) => i.sku)).toContain("sku_a");
  });
});

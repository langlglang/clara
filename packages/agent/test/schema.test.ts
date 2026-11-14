import { describe, expect, it } from "vitest";
import { replyJsonSchema, replyZodSchema, tidy } from "../src/schema.js";
import { state } from "./fixtures.js";

type Variant = { properties: { name: { enum: string[] }; step_id?: { enum: string[] }; question_id?: { enum: string[] }; sku?: { enum: string[] } } };
const variants = (s = state) => {
  const action = (replyJsonSchema(s) as { properties: { action: { anyOf: (Variant | { type: "null" })[] } } }).properties.action;
  return action.anyOf.filter((v): v is Variant => "properties" in v);
};
const named = (name: string, s = state) => variants(s).find((v) => v.properties.name.enum[0] === name);

describe("replyJsonSchema", () => {
  it("offers only the allowed steps, questions and in-stock skus", () => {
    expect(named("select_step")!.properties.step_id!.enum).toEqual(["start", "pressure", "tourniquet"]);
    expect(named("ask_clarifying")!.properties.question_id!.enum).toEqual(["where"]);
    expect(named("locate_item")!.properties.sku!.enum).toEqual(["GAUZE-01"]);
    expect(named("record_usage")).toBeUndefined();
  });

  it("offers only visual IDs supplied by the box", () => {
    const offered = { ...state, available_visuals: [{ visual_id: "kit_overview", label: "Clara kit layout" }] };
    expect(named("show_visual", offered)).toBeDefined();
    expect(replyZodSchema(offered).safeParse({ transcript: "show me", reply: "", action: { name: "show_visual", visual_id: "kit_overview" } }).success).toBe(true);
    expect(replyZodSchema(offered).safeParse({ transcript: "show me", reply: "", action: { name: "show_visual", visual_id: "https://example.com/evil.svg" } }).success).toBe(false);
    expect(named("show_visual")).toBeUndefined();
  });

  it("offers a single camera action without a second confirmation turn", () => {
    const camera = { ...state, camera_available: true, pending_camera_consent: "cloud_interpretation" as const };
    expect(named("request_camera", camera)).toBeDefined();
    expect(named("capture_camera", camera)).toBeUndefined();
    expect(replyZodSchema(camera).safeParse({ transcript: "take a photo", reply: "", action: { name: "capture_camera" } }).success).toBe(false);
  });

  it("leaves out actions with nothing to choose from, and triage when unavailable", () => {
    const empty = { ...state, allowed_steps: [], questions: [], manifest: [] };
    expect(variants(empty).map((v) => v.properties.name.enum[0])).toEqual(["suggest_sos"]);
    expect(named("start_triage")).toBeUndefined();
    expect(named("start_triage", { ...state, triage_available: true })).toBeDefined();
  });
  it("offers only configured guides and uses a provider-compatible triage schema", () => {
    const offered = { ...state, guided_scenarios: [{ scenario_id: "minor_cut", label: "Superficial cut", start_step_id: "get_bandage" }], triage_available: true };
    expect(named("start_guidance", offered)).toBeDefined();
    expect(replyZodSchema(offered).safeParse({ transcript: "small cut", reply: "", action: { name: "start_guidance", scenario_id: "minor_cut" } }).success).toBe(true);
    expect(replyZodSchema(offered).safeParse({ transcript: "small cut", reply: "", action: { name: "start_guidance", scenario_id: "unknown" } }).success).toBe(false);
    expect(replyJsonSchema(offered)).not.toMatchObject({ minimum: expect.anything() });
    expect(JSON.stringify(replyJsonSchema(offered))).not.toMatch(/"(?:minimum|maximum)"/);
  });

  it("is strict at every level", () => {
    const schema = replyJsonSchema(state) as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["transcript", "reply", "action"]);
    for (const v of variants()) expect((v as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("offers the caller answer action only for the pending task and question", () => {
    const pending = { task_id: "7f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f", question_id: "people_count" as const, prompt: "How many people need help?" };
    expect(named("answer_emergency_question")).toBeUndefined();
    expect(named("answer_emergency_question", { ...state, pending_emergency_question: pending })).toBeDefined();
    expect(replyZodSchema({ ...state, pending_emergency_question: pending }).safeParse({ transcript: "Two people", reply: "", action: { name: "answer_emergency_question", task_id: pending.task_id, question_id: pending.question_id } }).success).toBe(true);
    expect(replyZodSchema({ ...state, pending_emergency_question: pending }).safeParse({ transcript: "Two people", reply: "", action: { name: "answer_emergency_question", task_id: pending.task_id, question_id: "situation" } }).success).toBe(false);
  });
});

describe("replyZodSchema", () => {
  const parse = (action: unknown, s = state) => replyZodSchema(s).safeParse({ transcript: "x", reply: "", action });
  it("accepts offered IDs and rejects others", () => {
    expect(parse({ name: "select_step", step_id: "pressure" }).success).toBe(true);
    expect(parse({ name: "select_step", step_id: "packing" }).success).toBe(false);
    expect(parse({ name: "locate_item", sku: "TQ-01" }).success).toBe(false);
    expect(parse({ name: "start_triage" }).success).toBe(false);
    expect(parse({ name: "start_triage" }, { ...state, triage_available: true }).success).toBe(true);
    expect(parse({ name: "suggest_sos", extra: 1 }).success).toBe(false);
    expect(parse({ name: "record_usage", items: [{ sku: "GAUZE-01", qty: 1 }] }).success).toBe(false);
    expect(parse(null).success).toBe(true);
  });
});

describe("tidy", () => {
  it("removes markup and stray punctuation without changing words", () => {
    expect(tidy("  **Tap** the  step..}")).toBe("Tap the step.");
  });
});

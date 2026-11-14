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

  it("leaves out actions with nothing to choose from, and triage when unavailable", () => {
    const empty = { ...state, allowed_steps: [], questions: [], manifest: [] };
    expect(variants(empty).map((v) => v.properties.name.enum[0])).toEqual(["suggest_sos"]);
    expect(named("start_triage")).toBeUndefined();
    expect(named("start_triage", { ...state, triage_available: true })).toBeDefined();
  });

  it("is strict at every level", () => {
    const schema = replyJsonSchema(state) as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["transcript", "reply", "action"]);
    for (const v of variants()) expect((v as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false);
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

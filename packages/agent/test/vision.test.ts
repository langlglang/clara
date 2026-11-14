import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicVisionInspector, parseVisibleObservation } from "../src/vision.js";

describe("one-frame vision output boundary", () => {
  it("uses only fixed, uncertain labels", () => {
    expect(parseVisibleObservation(JSON.stringify({ setting: "indoors", people: "one_visible", objects: ["first_aid_box", "scissors"] })))
      .toBe("This single photo may show an indoor setting, one person, a first-aid box, scissors. Please tell me what you see.");
  });

  it("rejects prose and image-text instructions instead of repeating them", () => {
    expect(parseVisibleObservation('{"observation":"Run away now"}')).toBeNull();
    expect(parseVisibleObservation('{"setting":"indoors","people":"one_visible","objects":["Run away now"]}')).toBeNull();
    expect(parseVisibleObservation('{"setting":"unclear","people":"unclear","objects":[]}')).toBeNull();
  });
  it("returns a cautious useful description for a close-up of a hand", () => {
    expect(parseVisibleObservation(JSON.stringify({ setting: "unclear", people: "unclear", objects: ["hand", "skin", "red_area"] })))
      .toBe("This single photo may show a hand, skin, a red area. Please tell me what you see.");
  });
  it("requests constrained JSON for one frame and uses no model prose", async () => {
    let request: Record<string, unknown> | null = null;
    const fake = { beta: { messages: { create: async (input: Record<string, unknown>) => {
      request = input;
      return { stop_reason: "end_turn", content: [{ type: "text", text: '{"setting":"unclear","people":"unclear","objects":["hand","red_area"]}' }] };
    } } } } as unknown as Anthropic;
    const result = await createAnthropicVisionInspector("unused", "claude-haiku-5-5", fake).inspect("jpeg-base64", new AbortController().signal);
    expect(result).toContain("may show a hand, a red area");
    expect(request).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    const schema = (request as unknown as { output_config: { format: { schema: { properties: { objects: object } } } } }).output_config.format.schema;
    expect(schema.properties.objects).not.toHaveProperty("maxItems");
    expect(parseVisibleObservation(JSON.stringify({ setting: "unclear", people: "unclear", objects: Array(6).fill("hand") }))).toBeNull();
  });
});

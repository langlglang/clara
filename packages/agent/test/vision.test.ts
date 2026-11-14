import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicVisionInspector, parseVisibleObservation } from "../src/vision.js";

describe("multimodal one-frame observation", () => {
  const detail = { scene: "A hand is held close to the camera over a table.",
    visible_details: ["A short red line is visible on the index finger near the middle joint.", "No bandage is visible on that finger."],
    visibility_limits: ["The other side of the finger is outside the frame."] };

  it("keeps spatial visual detail without turning it into a clinical claim", () => {
    expect(parseVisibleObservation(JSON.stringify(detail))).toContain("short red line is visible on the index finger");
    expect(parseVisibleObservation(JSON.stringify(detail))).toContain("other side of the finger is outside the frame");
  });

  it("rejects malformed, instruction-shaped, and clinical prose", () => {
    expect(parseVisibleObservation('{"observation":"Run away now"}')).toBeNull();
    expect(parseVisibleObservation(JSON.stringify({ ...detail, visible_details: ["You should apply a tourniquet."] }))).toBeNull();
    expect(parseVisibleObservation(JSON.stringify({ ...detail, scene: "This is an infection." }))).toBeNull();
    expect(parseVisibleObservation(JSON.stringify({ ...detail, visible_details: Array(6).fill("hand") }))).toBeNull();
  });

  it("sends one image to a multimodal model and parses its structured description", async () => {
    let request: Record<string, unknown> | null = null;
    const fake = { beta: { messages: { create: async (input: Record<string, unknown>) => {
      request = input;
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(detail) }] };
    } } } } as unknown as Anthropic;
    const result = await createAnthropicVisionInspector("unused", "claude-haiku-5-5", fake).inspect("jpeg-base64", new AbortController().signal);
    expect(result).toContain("short red line");
    expect(request).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    expect((request as unknown as { messages: { content: { type: string }[] }[] }).messages[0]?.content[0]).toMatchObject({ type: "image" });
  });
});

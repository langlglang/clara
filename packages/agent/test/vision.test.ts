import { describe, expect, it, vi } from "vitest";
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

  it("rejects malformed responses and removes instruction-shaped or clinical prose", () => {
    expect(parseVisibleObservation('{"observation":"Run away now"}')).toBeNull();
    expect(parseVisibleObservation(JSON.stringify({ ...detail, visible_details: ["You should apply a tourniquet."] }))).not.toContain("tourniquet");
    expect(parseVisibleObservation(JSON.stringify({ ...detail, scene: "This is an infection." }))).not.toContain("infection");
    expect(parseVisibleObservation(JSON.stringify({ scene: "This is an infection.", visible_details: [], visibility_limits: [] }))).toBeNull();
    expect(parseVisibleObservation(JSON.stringify({ ...detail, visible_details: Array(11).fill("hand") }))).toBeNull();
  });

  it("accepts a detailed but bounded frame description", () => {
    const long = { ...detail, scene: `A hand near the camera. ${"Several objects are on the table. ".repeat(12)}`,
      visible_details: Array(6).fill("A small red mark is visible on one finger.") };
    const parsed = parseVisibleObservation(JSON.stringify(long));
    expect(parsed).toContain("small red mark");
    expect(parsed!.length).toBeLessThanOrEqual(1400);
  });

  it("keeps visible details when a limitation mentions diagnosis", () => {
    const parsed = parseVisibleObservation(JSON.stringify({ ...detail, visibility_limits: ["A diagnosis cannot be made from one image."] }));
    expect(parsed).toContain("red line");
    expect(parsed).not.toContain("diagnosis");
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

  it("does not use a truncated structured response", async () => {
    const fake = { beta: { messages: { create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: JSON.stringify(detail) }] }) } } } as unknown as Anthropic;
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await createAnthropicVisionInspector("unused", "claude-haiku-5-5", fake).inspect("jpeg-base64", new AbortController().signal)).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});

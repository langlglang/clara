import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistant, parseReply, RejectedReply } from "../src/assistant.js";
import { json, scriptedModel, state } from "./fixtures.js";

const good = json({ transcript: "bleeding", reply: "", action: { name: "select_step", step_id: "pressure" } });
const comfort = json({ transcript: "bleeding", reply: "You'll be fine.", action: null });

afterEach(() => vi.useRealTimers());

describe("parseReply", () => {
  const parse = (value: unknown) => parseReply(JSON.stringify(value), state);

  it("accepts an allowed step and drops the model's words for it", () => {
    expect(parse({ transcript: "it's bleeding", reply: "Okay, press now.", action: { name: "select_step", step_id: "pressure" } })).toEqual({
      transcript: "it's bleeding",
      reply: "",
      action: { name: "select_step", step_id: "pressure" },
    });
  });

  it("rejects a step that wasn't offered", () => {
    expect(() => parse({ transcript: "x", reply: "", action: { name: "select_step", step_id: "packing" } })).toThrow(/not offered/);
  });

  it("rejects usage above what is on hand (actionAllowed)", () => {
    expect(() => parse({ transcript: "x", reply: "Got it.", action: { name: "record_usage", items: [{ sku: "GAUZE-01", qty: 3 }] } })).toThrow(/on hand/);
  });

  it("rejects an empty reply without a step or question, and allows it with ask_clarifying", () => {
    expect(() => parse({ transcript: "x", reply: "", action: null })).toThrow(/write a short reply/);
    expect(parse({ transcript: "x", reply: "", action: { name: "ask_clarifying", question_id: "where" } }).reply).toBe("");
  });

  it("runs the honesty guard with a note naming the rule", () => {
    expect(() => parse({ transcript: "x", reply: "Stay calm, help is on the way.", action: null })).toThrow(/on the way/);
    expect(() => parse({ transcript: "x", reply: "It sounds like a fracture.", action: { name: "suggest_sos" } })).toThrow(/diagnose/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseReply("{not json", state)).toThrow(RejectedReply);
  });
});

describe("createAssistant", () => {
  it("retries once with a note after the honesty guard blocks", async () => {
    const model = scriptedModel([comfort, good]);
    const result = await createAssistant(model).reply(state, "en", "bleeding", 2_000);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(model.notes[0]).toBeNull();
    expect(model.notes[1]).toMatch(/Never reassure/);
  });

  it("retries an action that isn't allowed, then gives up after the second", async () => {
    const overuse = json({ transcript: "x", reply: "Noted.", action: { name: "record_usage", items: [{ sku: "GAUZE-01", qty: 5 }] } });
    const model = scriptedModel([overuse, overuse]);
    const result = await createAssistant(model).reply(state, "en", "I used five gauze", 2_000);
    expect(result).toMatchObject({ ok: false, reason: "invalid_reply", attempts: 2 });
    expect(model.notes[1]).toMatch(/not offered or more than is on hand/);
  });

  it("treats a refusal as final, with no retry", async () => {
    const model = scriptedModel([{ text: "", stopReason: "refusal" }, good]);
    const result = await createAssistant(model).reply(state, "en", "x", 2_000);
    expect(result).toMatchObject({ ok: false, reason: "refusal", attempts: 1 });
    expect(model.notes).toHaveLength(1);
  });

  it("reports an API error without retrying", async () => {
    const result = await createAssistant(scriptedModel([new Error("500"), good])).reply(state, "en", "x", 2_000);
    expect(result).toMatchObject({ ok: false, reason: "model_error", attempts: 1 });
  });

  it("times out at its limit", async () => {
    vi.useFakeTimers();
    const pending = createAssistant(scriptedModel(["hang"])).reply(state, "en", "x", 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("times out even when the model ignores its signal", async () => {
    vi.useFakeTimers();
    const deaf = { name: "deaf", generate: () => new Promise<never>(() => {}) };
    const pending = createAssistant(deaf).reply(state, "en", "x", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
  });
});

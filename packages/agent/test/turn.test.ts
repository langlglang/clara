import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnResponseSchema } from "@clara/contracts";
import { createAssistant, type Assistant } from "../src/assistant.js";
import type { Ears, Voice } from "../src/cartesia.js";
import { createClaraAgent } from "../src/index.js";
import { createKeywordStubModel } from "../src/model.js";
import { FIXED_LINES, handleTurn } from "../src/turn.js";
import { audioInput, json, scriptedModel, state, textRequest, wav } from "./fixtures.js";

const voice = (result: Buffer | null = wav): Voice & { said: string[] } => {
  const said: string[] = [];
  return { sampleRate: 16_000, said, speak: async (text) => (said.push(text), result) };
};
const ears = (words: string | null): Ears & { languages: string[] } => {
  const languages: string[] = [];
  return { languages, transcribe: async (_clip, language) => (languages.push(language), words) };
};
const assistantFor = (...outputs: Parameters<typeof scriptedModel>[0]) => createAssistant(scriptedModel(outputs));

afterEach(() => vi.useRealTimers());

describe("handleTurn", () => {
  it("voices the exact server-owned guidance text, ignoring model wording", async () => {
    const v = voice();
    const response = await handleTurn(textRequest("my friend's leg is bleeding"), {
      assistant: assistantFor(json({ transcript: "x", reply: "Press now.", action: { name: "select_step", step_id: "pressure" } })),
      ears: null,
      voice: v,
      guidance: (scenarioId, stepId) => scenarioId === "demo_bleeding" && stepId === "pressure" ? "Checked demo guidance text." : null,
    });
    expect(TurnResponseSchema.parse(response)).toMatchObject({ answered_by: "model", action: { name: "select_step", step_id: "pressure" }, reply: "Checked demo guidance text." });
    expect(response.speech?.mime).toBe("audio/wav");
    expect(v.said).toEqual(["Checked demo guidance text."]);
    expect(TurnResponseSchema.safeParse({ ...response, schema_version: "voice-turn/0.1" }).success).toBe(false);
  });

  it("refuses selected guidance missing from the server bundle", async () => {
    const response = await handleTurn(textRequest("my friend's leg is bleeding"), {
      assistant: assistantFor(json({ transcript: "x", reply: "", action: { name: "select_step", step_id: "pressure" } })),
      ears: null,
      voice: voice(),
      guidance: () => null,
    });
    expect(response).toMatchObject({ answered_by: "fixed", reason: "invalid_reply", action: null });
  });

  it("returns canonical text with no WAV when Cartesia fails, for local fallback", async () => {
    const response = await handleTurn(textRequest("my friend's leg is bleeding"), {
      assistant: assistantFor(json({ transcript: "x", reply: "", action: { name: "select_step", step_id: "pressure" } })),
      ears: null,
      voice: voice(null),
      guidance: () => "Checked demo guidance text.",
    });
    expect(response).toMatchObject({ action: { name: "select_step", step_id: "pressure" }, reply: "Checked demo guidance text.", speech: null });
  });

  it("transcribes audio in the session's language and speaks a worded reply", async () => {
    const e = ears("where is the gauze");
    const v = voice();
    const response = await handleTurn(textRequest("", { language: "es", input: audioInput }), {
      assistant: assistantFor(json({ transcript: "where is the gauze", reply: "Look for the lit slot.", action: { name: "locate_item", sku: "GAUZE-01" } })),
      ears: e,
      voice: v,
    });
    expect(e.languages).toEqual(["es"]);
    expect(TurnResponseSchema.parse(response)).toMatchObject({ heard: "where is the gauze", reply: "Look for the lit slot.", action: { name: "locate_item" } });
    expect(response.speech?.mime).toBe("audio/wav");
    expect(v.said).toEqual(["Look for the lit slot."]);
  });

  it("speaks the question text when ask_clarifying has no reply", async () => {
    const v = voice();
    const response = await handleTurn(textRequest("help"), { assistant: assistantFor(json({ transcript: "help", reply: "", action: { name: "ask_clarifying", question_id: "where" } })), ears: null, voice: v });
    expect(response.reply).toBe(state.questions[0]!.text);
    expect(v.said).toEqual([state.questions[0]!.text]);
  });

  it("gives the fixed 'didn't catch that' line for an empty transcript, with no model call", async () => {
    const model = scriptedModel([json({ transcript: "", reply: "Hi.", action: null })]);
    const response = await handleTurn(textRequest("", { input: audioInput }), { assistant: createAssistant(model), ears: ears("   "), voice: null });
    expect(response).toMatchObject({ answered_by: "fixed", reason: "not_heard", reply: FIXED_LINES.not_heard, heard: null, action: null });
    expect(model.notes).toHaveLength(0);
  });

  it("gives not_heard when speech-to-text fails or is missing, and no_model without a model", async () => {
    const request = textRequest("", { input: audioInput });
    expect(await handleTurn(request, { assistant: null, ears: null, voice: null })).toMatchObject({ reason: "not_heard" });
    expect(await handleTurn(request, { assistant: null, ears: ears(null), voice: null })).toMatchObject({ reason: "not_heard" });
    expect(await handleTurn(request, { assistant: null, ears: ears("bleeding"), voice: null })).toMatchObject({ reason: "no_model", heard: "bleeding" });
  });

  it("falls back to a fixed line after an unallowed action twice", async () => {
    const bad = json({ transcript: "x", reply: "", action: { name: "select_step", step_id: "packing" } });
    const response = await handleTurn(textRequest("x"), { assistant: assistantFor(bad, bad), ears: null, voice: voice() });
    expect(TurnResponseSchema.parse(response)).toMatchObject({ answered_by: "fixed", reason: "invalid_reply", action: null, reply: FIXED_LINES.invalid_reply });
    expect(response.speech).not.toBeNull();
  });

  it("re-checks actionAllowed even when an assistant skips it", async () => {
    const sloppy: Assistant = { reply: async () => ({ ok: true, attempts: 1, ms: 1, model: "x", reply: { transcript: "x", reply: "", action: { name: "select_step", step_id: "packing" } } }) };
    expect(await handleTurn(textRequest("x"), { assistant: sloppy, ears: null, voice: null })).toMatchObject({ answered_by: "fixed", reason: "invalid_reply" });
  });

  it("falls back to a fixed line when the honesty guard blocks twice", async () => {
    const promise = json({ transcript: "x", reply: "An ambulance is on the way.", action: null });
    expect(await handleTurn(textRequest("x"), { assistant: assistantFor(promise, promise), ears: null, voice: null })).toMatchObject({ answered_by: "fixed", reason: "invalid_reply" });
  });

  it("gives the refusal line on a refusal", async () => {
    const response = await handleTurn(textRequest("x"), { assistant: assistantFor({ text: "", stopReason: "refusal" }), ears: null, voice: null });
    expect(response).toMatchObject({ answered_by: "fixed", reason: "refusal", reply: FIXED_LINES.refusal });
  });

  it("returns speech null when text-to-speech fails, so the box speaks", async () => {
    const response = await handleTurn(textRequest("x"), { assistant: assistantFor(json({ transcript: "x", reply: "Tell me more.", action: null })), ears: null, voice: voice(null) });
    expect(response).toMatchObject({ answered_by: "model", reply: "Tell me more.", speech: null });
  });

  it("ends within its budget when the model hangs (fake clock)", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let done: Awaited<ReturnType<typeof handleTurn>> | undefined;
    void handleTurn(textRequest("x"), { assistant: assistantFor("hang"), ears: null, voice: null }).then((r) => (done = r));
    while (!done) await vi.advanceTimersByTimeAsync(50);
    expect(done).toMatchObject({ answered_by: "fixed", reason: "timeout", action: null });
    expect(Date.now() - started).toBeLessThanOrEqual(8_000 - 900 + 50);
  });

  it("logs no transcript or reply words", async () => {
    const lines: string[] = [];
    await handleTurn(textRequest("my secret words"), { assistant: assistantFor(json({ transcript: "my secret words", reply: "Tell me more.", action: null })), ears: null, voice: null, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/secret|Tell me/);
  });
});

describe("createClaraAgent", () => {
  it("runs without keys: text turns get no_model, and the stub works when asked for", async () => {
    expect(await createClaraAgent({}).handleTurn(textRequest("x"))).toMatchObject({ reason: "no_model" });
    const stub = createClaraAgent({ CLARA_MODEL: "stub" }, { guidance: (_scenarioId, stepId) => stepId === "pressure" ? "Checked demo guidance text." : null });
    expect(await stub.handleTurn(textRequest("press on the bleeding"))).toMatchObject({ action: { name: "select_step", step_id: "pressure" } });
    expect(stub.describe).not.toMatch(/sk-/);
  });

  it("uses Haiku with an Opus backup by default", () => {
    expect(createClaraAgent({ ANTHROPIC_API_KEY: "test-key" }).describe).toMatch(/claude-haiku-5-5 \(backup claude-opus-5-5 after 2500 ms\)/);
    expect(createClaraAgent({ ANTHROPIC_API_KEY: "test-key", CLARA_BACKUP_MODEL: "none" }).describe).toMatch(/model: claude-haiku-5-5;/);
  });

  it("keyword stub output passes the same checks", async () => {
    const response = await handleTurn(textRequest("she is not breathing"), { assistant: createAssistant(createKeywordStubModel()), ears: null, voice: null });
    expect(response).toMatchObject({ answered_by: "model", action: { name: "suggest_sos" } });
  });

  it("a greeting does not start the scenario or ask an injury-specific question", async () => {
    const request = textRequest("hello", { state: { ...state, step_id: null, allowed_steps: [state.allowed_steps[0]!] } });
    const response = await handleTurn(request, { assistant: createAssistant(createKeywordStubModel()), ears: null, voice: null });
    expect(response).toMatchObject({ answered_by: "model", action: null, reply: "I'm here. Tell me what happened." });
  });

  it("locates a requested in-stock kit item without selecting a scenario panel", async () => {
    const request = textRequest("Where can I find the gauze?", { state: { ...state, step_id: null, allowed_steps: [state.allowed_steps[0]!] } });
    const response = await handleTurn(request, { assistant: createAssistant(createKeywordStubModel()), ears: null, voice: null });
    expect(response).toMatchObject({ answered_by: "model", action: { name: "locate_item", sku: "GAUZE-01" } });
  });
});

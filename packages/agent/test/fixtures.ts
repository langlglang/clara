import { VOICE_TURN_VERSION, type TurnRequest, type TurnState } from "@clara/contracts";
import type { ModelOutput, ReplyModel } from "../src/model.js";

export const state: TurnState = {
  scenario_id: "demo_bleeding",
  step_id: "start",
  allowed_steps: [
    { step_id: "start", label: "Tell me what happened" },
    { step_id: "pressure", label: "Press hard on the bleeding wound" },
    { step_id: "tourniquet", label: "Apply the tourniquet on the arm or leg" },
  ],
  questions: [{ question_id: "where", text: "Where is the bleeding: an arm, a leg, or the body?" }],
  manifest: [
    { sku: "GAUZE-01", name: "gauze roll", on_hand: 2 },
    { sku: "TQ-01", name: "tourniquet", on_hand: 0 },
  ],
  triage_available: false,
  recent_turns: [],
};

export const ID = "7f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f";

export function textRequest(text: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { schema_version: VOICE_TURN_VERSION, client_turn_id: ID, session_id: ID, language: "en", input: { type: "text", text }, state, ...overrides };
}

export const wav = Buffer.concat([Buffer.from("RIFF0000WAVE", "ascii"), Buffer.alloc(60)]);
export const audioInput = { type: "audio", mime: "audio/wav", data_base64: wav.toString("base64"), duration_ms: 900 } as const;

export const json = (value: unknown): ModelOutput => ({ text: JSON.stringify(value), stopReason: "end_turn" });

/** A model that answers from a script, one output per call, optionally after a delay; records retry notes. */
export function scriptedModel(outputs: (ModelOutput | Error | "hang")[], delayMs = 0, name = "scripted"): ReplyModel & { notes: (string | null)[] } {
  const notes: (string | null)[] = [];
  let call = 0;
  return {
    name,
    notes,
    generate(request, signal) {
      notes.push(request.retryNote);
      const next = outputs[Math.min(call++, outputs.length - 1)]!;
      return new Promise((resolve, reject) => {
        if (next === "hang") return signal.addEventListener("abort", () => reject(new Error("aborted")));
        const timer = setTimeout(() => (next instanceof Error ? reject(next) : resolve(next)), delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    },
  };
}

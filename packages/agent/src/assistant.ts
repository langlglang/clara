// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/assistant.ts.
import { actionAllowed, type FixedReason, type TurnState } from "@clara/contracts";
import { checkHonesty } from "./honesty.js";
import type { ReplyModel } from "./model.js";
import { SYSTEM_PROMPT, turnContext } from "./prompt.js";
import { replyJsonSchema, replyZodSchema, type ModelReply } from "./schema.js";

/**
 * One model's attempt at a turn: up to two calls (the second carries a server note naming the broken rule),
 * inside a deadline. Failures are results, never throws.
 */
export type AssistantFailure = Exclude<FixedReason, "not_heard" | "no_model">;
export type AssistantResult =
  | { ok: true; reply: ModelReply; attempts: number; ms: number; model: string }
  | { ok: false; reason: AssistantFailure; attempts: number; ms: number; model: string };

export interface Assistant {
  reply(state: TurnState, language: string, words: string, limitMs: number, signal?: AbortSignal): Promise<AssistantResult>;
}

/** A reply the server will not use; `note` goes back to the model on the retry. */
export class RejectedReply extends Error {
  constructor(
    readonly reason: "invalid_reply" | "refusal",
    readonly note: string,
  ) {
    super(note || reason);
  }
}

/** Parses and checks the model's JSON for this turn; throws RejectedReply with a note for the retry. */
export function parseReply(text: string, state: TurnState): ModelReply {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RejectedReply("invalid_reply", "Server note: your previous reply wasn't valid JSON. Reply with the JSON shape only.");
  }
  const result = replyZodSchema(state).safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "reply"}: ${i.message}`);
    throw new RejectedReply("invalid_reply", `Server note: your previous reply broke the shape or named an option that was not offered (${issues.join("; ")}).`);
  }
  const reply: ModelReply = result.data;
  if (reply.action && !actionAllowed(reply.action, state)) {
    throw new RejectedReply("invalid_reply", "Server note: your previous action named something that was not offered or more than is on hand. Choose only from the options given.");
  }
  // select_step plays the step's own recorded audio, so the model's words are not used.
  if (reply.action?.name === "select_step" || reply.action?.name === "start_guidance") return { ...reply, reply: "" };
  if (reply.action?.name === "show_visual") return { ...reply, reply: "" };
  if (reply.action?.name === "assess_patient") return { ...reply, reply: "" };
  if (reply.action?.name === "read_pulse" || reply.action?.name === "request_camera" || reply.action?.name === "capture_camera") return { ...reply, reply: "" };
  if (!reply.reply && reply.action?.name !== "ask_clarifying" && reply.action?.name !== "answer_emergency_question") {
    throw new RejectedReply("invalid_reply", "Server note: write a short reply, or choose an action that uses fixed wording.");
  }
  const broken = checkHonesty(reply.reply);
  if (broken) throw new RejectedReply("invalid_reply", `Server note: your previous reply broke a rule. ${broken.note}`);
  return reply;
}

/** An AbortSignal that fires after `ms` (setTimeout-based, so fake clocks drive it), plus a way to stop it. */
export function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline")), Math.max(1, ms));
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Settles with the promise, or rejects as soon as the signal aborts (a model that ignores its signal can't hang a turn). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createAssistant(model: ReplyModel): Assistant {
  return {
    async reply(state, language, words, limitMs, cancel) {
      const started = Date.now();
      const limit = deadline(limitMs);
      const signal = cancel ? AbortSignal.any([limit.signal, cancel]) : limit.signal;
      const schema = replyJsonSchema(state);
      const context = turnContext(state, language, words);
      let retryNote: string | null = null;
      let reason: AssistantFailure = "invalid_reply";
      let attempts = 0;
      try {
        while (attempts < 2) {
          attempts++;
          try {
            const output = await untilAborted(model.generate({ system: SYSTEM_PROMPT, context, retryNote, schema }, signal), signal);
            if (output.stopReason === "refusal") throw new RejectedReply("refusal", "");
            const reply = parseReply(output.text, state);
            return { ok: true, reply, attempts, ms: Date.now() - started, model: model.name };
          } catch (error) {
            if (!(error instanceof RejectedReply)) {
              reason = limit.signal.aborted ? "timeout" : "model_error";
              break;
            }
            reason = error.reason;
            if (error.reason === "refusal") break;
            retryNote = error.note;
          }
        }
        return { ok: false, reason, attempts, ms: Date.now() - started, model: model.name };
      } finally {
        limit.clear();
      }
    },
  };
}

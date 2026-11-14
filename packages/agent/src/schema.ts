// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/assistant.ts (per-turn schema with enums of what is allowed).
import { z } from "zod";
import { ActionSchema, MAX_HEARD, MAX_REPLY, type Action, type TurnState } from "@clara/contracts";

/**
 * The reply's shape for one turn, as a JSON schema (sent to the model as `output_config.format`) and as a zod
 * schema (checked on the server). Both are rebuilt from TurnState every turn so `step_id`, `question_id` and
 * `sku` are enums of what the box offered right now; actions with nothing to choose from are left out.
 */

export interface ModelReply {
  transcript: string;
  reply: string;
  action: Action | null;
}

/** What each action can name this turn. Supplies with none on hand cannot be located or recorded. */
export function allowedOptions(state: TurnState) {
  return {
    stepIds: state.allowed_steps.map((s) => s.step_id),
    questionIds: state.questions.map((q) => q.question_id),
    skus: state.manifest.filter((m) => m.on_hand > 0).map((m) => m.sku),
    triage: state.triage_available,
  };
}

export function replyJsonSchema(state: TurnState): Record<string, unknown> {
  const { stepIds, questionIds, skus, triage } = allowedOptions(state);
  const variants: Record<string, unknown>[] = [{ type: "null" }];
  const obj = (name: string, props: Record<string, unknown> = {}) => ({
    type: "object",
    additionalProperties: false,
    required: ["name", ...Object.keys(props)],
    properties: { name: { type: "string", enum: [name] }, ...props },
  });
  if (stepIds.length > 0) variants.push(obj("select_step", { step_id: { type: "string", enum: stepIds } }));
  if (questionIds.length > 0) variants.push(obj("ask_clarifying", { question_id: { type: "string", enum: questionIds } }));
  if (skus.length > 0) {
    variants.push(obj("locate_item", { sku: { type: "string", enum: skus } }));
    variants.push(
      obj("record_usage", {
        items: {
          type: "array",
          description: "Supplies the person says they used, each at most the quantity on hand.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sku", "qty"],
            properties: { sku: { type: "string", enum: skus }, qty: { type: "integer" } },
          },
        },
      }),
    );
  }
  if (triage) variants.push(obj("start_triage"));
  variants.push(obj("suggest_sos"));
  return {
    type: "object",
    additionalProperties: false,
    required: ["transcript", "reply", "action"],
    properties: {
      transcript: { type: "string", description: "A copy of person_words." },
      reply: {
        type: "string",
        description: `What Clara says aloud: at most two short sentences, under ${MAX_REPLY - 50} characters. Empty with select_step.`,
      },
      action: { anyOf: variants, description: "At most one action, chosen only from the options offered." },
    },
  };
}

const oneOf = (values: string[]) => z.enum(values as [string, ...string[]]);

/** The zod twin of replyJsonSchema; `reply` is tidied before its length is checked. */
export function replyZodSchema(state: TurnState) {
  const { stepIds, questionIds, skus, triage } = allowedOptions(state);
  const variants: z.ZodType[] = [];
  if (stepIds.length > 0) variants.push(z.strictObject({ name: z.literal("select_step"), step_id: oneOf(stepIds) }));
  if (questionIds.length > 0) variants.push(z.strictObject({ name: z.literal("ask_clarifying"), question_id: oneOf(questionIds) }));
  if (skus.length > 0) {
    variants.push(z.strictObject({ name: z.literal("locate_item"), sku: oneOf(skus) }));
    variants.push(
      z.strictObject({
        name: z.literal("record_usage"),
        items: z.array(z.strictObject({ sku: oneOf(skus), qty: z.number().int().min(1).max(99) })).min(1).max(10),
      }),
    );
  }
  if (triage) variants.push(z.strictObject({ name: z.literal("start_triage") }));
  variants.push(z.strictObject({ name: z.literal("suggest_sos") }));
  const action = (variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]])).pipe(ActionSchema);
  return z.strictObject({
    transcript: z.string().max(MAX_HEARD),
    reply: z.string().transform(tidy).pipe(z.string().max(MAX_REPLY)),
    action: action.nullable(),
  });
}

// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/model-text.ts.
/** Tidies model text before it is checked or spoken: no markdown or stray braces, one full stop, single spaces. */
export function tidy(text: string): string {
  return text
    .replace(/[{}[\]<>`*_#]/g, "")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/([!?])\.(?!\.)/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

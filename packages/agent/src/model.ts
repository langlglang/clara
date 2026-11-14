// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/onboarding/anthropic.ts.
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MAIN_MODEL = "claude-haiku-5-5";
export const DEFAULT_BACKUP_MODEL = "claude-opus-5-5";

/** One structured-output request: the fixed policy, this turn's context, an optional retry note, and the schema. */
export interface ModelRequest {
  system: string;
  context: string;
  retryNote: string | null;
  schema: Record<string, unknown>;
}

export interface ModelOutput {
  /** The concatenated text blocks; empty on a refusal. */
  text: string;
  stopReason: string | null;
}

/** What the assistant needs from a model. Tests pass a fake. */
export interface ReplyModel {
  readonly name: string;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelOutput>;
}

/**
 * Claude with structured output, one call per attempt. These models reject a forced `tool_choice`, so the one
 * decision comes back as JSON constrained by `output_config.format` (a schema rebuilt every turn). Effort is
 * low for voice latency; the policy is a cached system block, and the turn's context is the only user message.
 * `fallbacks: "default"` (beta) lets the API re-run a policy decline on another model inside the same call; it
 * is sent only to models that accept it (not Haiku). The SDK's own retries are off: the turn's deadline and the
 * main/backup hedge decide what happens next.
 */
export function createClaudeModel({ apiKey, model = DEFAULT_MAIN_MODEL, client }: { apiKey?: string; model?: string; client?: Anthropic }): ReplyModel {
  const anthropic = client ?? new Anthropic({ apiKey, maxRetries: 0 });
  const serverFallback = !model.startsWith("claude-haiku");
  return {
    name: model,
    async generate(request, signal) {
      const content: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: request.context }];
      if (request.retryNote) content.push({ type: "text", text: request.retryNote });
      const response = await anthropic.beta.messages.create(
        {
          model,
          max_tokens: 2048,
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content }],
          output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
          ...(serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal },
      );
      // A refusal is checked before the content is read: its content is not a reply.
      if (response.stop_reason === "refusal") return { text: "", stopReason: "refusal" };
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      return { text, stopReason: response.stop_reason ?? null };
    },
  };
}

/**
 * Demo-only stand-in when no Anthropic key is set: matches the person's words against step labels, then falls
 * back to the first question. Its output goes through the same checks as Claude's.
 */
export function createKeywordStubModel(): ReplyModel {
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  return {
    name: "keyword-stub",
    async generate({ context }) {
      const turn = JSON.parse(context) as {
        person_words: string;
        current_step: string | null;
        allowed_steps: { step_id: string; label: string }[];
        questions: { question_id: string }[];
        manifest: { sku: string; name: string; on_hand: number }[];
      };
      const said = turn.person_words;
      const heard = tokens(said);
      const step = turn.allowed_steps.find((s) => [...tokens(s.label)].some((w) => heard.has(w)));
      const entry = !turn.current_step && /\b(blood|bleed|bleeding|wound)\b/i.test(said) ? turn.allowed_steps[0] : undefined;
      const sos = /\b(911|sos|emergency|dying|not breathing|unconscious|unresponsive)\b/i.test(said);
      const item = /\b(where|find|locate|grab|get)\b/i.test(said)
        ? turn.manifest.find((m) => m.on_hand > 0 && [...tokens(m.name)].some((w) => heard.has(w)))
        : undefined;
      const nextStep = step ?? entry;
      const relevantQuestion = /\b(blood|bleed|bleeding|wound|injured|hurt|pain)\b/i.test(said) && turn.current_step;
      const action = sos
        ? { name: "suggest_sos" }
        : item
          ? { name: "locate_item", sku: item.sku }
        : nextStep
          ? { name: "select_step", step_id: nextStep.step_id }
          : relevantQuestion && turn.questions[0]
            ? { name: "ask_clarifying", question_id: turn.questions[0].question_id }
            : null;
      const reply = action?.name === "suggest_sos"
        ? "Starting the simulated SOS countdown. No real call is made."
        : action?.name === "locate_item"
          ? "I'm showing the recorded kit location."
          : action
            ? ""
            : "I'm here. Tell me what happened.";
      return { text: JSON.stringify({ transcript: said, reply, action }), stopReason: "end_turn" };
    },
  };
}

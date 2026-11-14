import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createClaudeModel } from "../src/model.js";

/** A fake Anthropic client: records the request and answers with `message`. No network. */
function fakeClient(message: { stop_reason: string; content: unknown[] }) {
  const calls: { body: Record<string, unknown>; options: unknown }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (body: Record<string, unknown>, options: unknown) => {
          calls.push({ body, options });
          return message;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const request = { system: "policy", context: "{}", retryNote: "Server note: x", schema: { type: "object" } };

describe("createClaudeModel", () => {
  it("sends one structured-output call: low effort, json_schema, cached system, no forced tool choice", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: ' {"a":1} ' }] });
    const model = createClaudeModel({ client });
    expect(model.name).toBe("claude-haiku-5-5");
    const out = await model.generate(request, new AbortController().signal);
    expect(out).toEqual({ text: '{"a":1}', stopReason: "end_turn" });
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: "policy", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "{}" }, { type: "text", text: "Server note: x" }] }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("fallbacks");
    expect(calls[0]!.options).toHaveProperty("signal");
  });

  it("asks Opus with server-side fallbacks", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
    await createClaudeModel({ client, model: "claude-opus-5-5" }).generate(request, new AbortController().signal);
    expect(calls[0]!.body).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  });

  it("checks for a refusal before reading content", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [{ type: "text", text: '{"reply":"partial"}' }] });
    expect(await createClaudeModel({ client }).generate(request, new AbortController().signal)).toEqual({ text: "", stopReason: "refusal" });
  });
});

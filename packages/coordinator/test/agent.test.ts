import { ChatAnthropic } from "@langchain/anthropic";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel, deepAgentRunner } from "../src/agent.js";
import { createCoordinator } from "../src/coordinator.js";
import { fakeRides, harness, openSos } from "./helpers.js";

afterEach(() => void vi.useRealTimers());

describe("deep agent (fake chat model, no API calls)", () => {
  it("plans with write_todos, delegates to a subagent, acts through the enforced tools and keeps notes", async () => {
    const h = harness();
    const model = fakeModel()
      .respondWithTools([{ name: "write_todos", args: { todos: [{ content: "Read the incident", status: "in_progress" }, { content: "Ask responder-scout who to add", status: "pending" }, { content: "Alert and note", status: "pending" }] } }])
      .respondWithTools([{ name: "get_incident", args: {} }])
      .respondWithTools([{ name: "task", args: { subagent_type: "responder-scout", description: "Amina declined. Who should be alerted next for a bleed?" } }])
      // responder-scout's own turns (subagents share the fake model):
      .respondWithTools([{ name: "list_candidates", args: {} }])
      .respond(new AIMessage("Alert vol-grace (doctor, 0.3 km). vol-ghost is not a candidate."))
      .respondWithTools([
        { name: "alert_volunteers", args: { volunteer_ids: ["vol-grace", "vol-ghost"], reason: "Amina declined" } },
        { name: "write_file", args: { file_path: "/notes.md", content: "Run 1: Amina declined; trying Grace." } },
      ])
      .respondWithTools([{ name: "alert_volunteers", args: { volunteer_ids: ["vol-grace"], reason: "Amina declined; Grace is a doctor 0.3 km away" } }])
      .respondWithTools([{ name: "post_dispatch_note", args: { text: "Amina declined; alerted Grace (doctor, 0.3 km)." } }])
      .respondWithTools([{ name: "write_todos", args: { todos: [{ content: "Read the incident", status: "completed" }, { content: "Ask responder-scout who to add", status: "completed" }, { content: "Alert and note", status: "completed" }] } }])
      .respond(new AIMessage("Done: alerted Grace."));

    const c = createCoordinator({ network: h.net, rides: fakeRides(), runner: deepAgentRunner({ model, modelName: "fake" }), timers: false, debounceMs: 10, log: () => undefined });
    const id = openSos(h);
    c.trigger(id, "Amina declined");
    await c.idle();

    const log = c.getLog(id)!;
    expect(log.runs[0]).toMatchObject({ outcome: "ok" });
    expect(log.plan).toEqual([
      { content: "Read the incident", status: "completed" },
      { content: "Ask responder-scout who to add", status: "completed" },
      { content: "Alert and note", status: "completed" },
    ]);
    expect(log.subagents).toHaveLength(1);
    expect(log.subagents[0]).toMatchObject({ name: "responder-scout", result: expect.stringContaining("vol-grace") });
    expect(log.actions.find((a) => a.tool === "list_candidates")?.agent).toBe("responder-scout");
    const alerts = log.actions.filter((a) => a.tool === "alert_volunteers");
    expect(alerts.map((a) => a.ok)).toEqual([false, true]); // the ghost made the first call fail as a whole
    expect(log.extra_alerts).toBe(1);
    expect(h.net.incident(id)!.incident.alerts.some((a) => a.volunteer_id === "vol-grace")).toBe(true);
    expect(log.notes.map((n) => n.text)).toEqual(["Amina declined; alerted Grace (doctor, 0.3 km)."]);
    expect(log.memory).toEqual([expect.objectContaining({ path: "/notes.md", preview: "Run 1: Amina declined; trying Grace." })]);
    expect(model.callCount).toBe(10);
  });

  it("aborts at the deadline and logs a timeout", async () => {
    const h = harness();
    const late = fakeModel().respondWithTools([{ name: "alert_volunteers", args: { volunteer_ids: ["vol-grace"], reason: "late" } }]).respond(new AIMessage("late"));
    const runner = deepAgentRunner({ model: late, modelName: "fake" });
    const c = createCoordinator({
      network: h.net,
      runner: async (input) => {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
        await runner(input).catch(() => undefined);
      },
      timers: false,
      deadlineMs: 50,
      debounceMs: 10,
      log: () => undefined,
    });
    const id = openSos(h);
    c.trigger(id, "go");
    await c.idle();
    expect(c.getLog(id)!.runs[0]).toMatchObject({ outcome: "timeout" });
    await new Promise((r) => setTimeout(r, 50));
    // The agent ran after the deadline; its alert was refused and nothing reached the network.
    expect(h.net.incident(id)!.incident.alerts.some((a) => a.volunteer_id === "vol-grace")).toBe(false);
  });
});

describe("ChatAnthropic request shape for claude-opus-5-5", () => {
  it("sends no sampling params, no forced tool_choice, no prefill, and low effort", async () => {
    const requests: Record<string, unknown>[] = [];
    const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Nothing to do." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } };
    const create = async (req: Record<string, unknown>) => {
      requests.push(req);
      if (req.stream) {
        const events = [
          { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Nothing to do." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ];
        return Object.assign((async function* () { yield* events; })(), { controller: new AbortController() });
      }
      return message;
    };
    const fakeClient = { messages: { create }, beta: { messages: { create } } };
    const model = new ChatAnthropic({ model: "claude-opus-5-5", apiKey: "test-key", maxTokens: 4096, maxRetries: 0, outputConfig: { effort: "low" }, createClient: () => fakeClient as never });
    expect(createModel({ model })).toBe(model);

    const h = harness();
    const c = createCoordinator({ network: h.net, runner: deepAgentRunner({ model, modelName: "claude-opus-5-5" }), timers: false, debounceMs: 10, log: () => undefined });
    const id = openSos(h);
    c.trigger(id, "incident opened");
    await c.idle();
    expect(c.getLog(id)!.runs[0]).toMatchObject({ outcome: "ok" });

    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.model).toBe("claude-opus-5-5");
      expect(req).not.toHaveProperty("temperature");
      expect(req).not.toHaveProperty("top_p");
      expect(req).not.toHaveProperty("top_k");
      expect(req.thinking).toBeUndefined();
      const choice = req.tool_choice as { type?: string } | undefined;
      expect(choice === undefined || choice.type === "auto" || choice.type === "none").toBe(true);
      expect(req.output_config).toMatchObject({ effort: "low" });
      const messages = req.messages as { role: string }[];
      expect(messages.at(-1)!.role).toBe("user"); // no assistant prefill
      const names = (req.tools as { name: string }[]).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["write_todos", "task", "write_file", "alert_volunteers", "request_kit", "propose_ride", "post_dispatch_note", "flag_for_dispatcher", "get_incident"]));
    }
  });

  it("the default model omits sampling params too", () => {
    const m = createModel({ apiKey: "test-key" }) as ChatAnthropic;
    const params = m.invocationParams({} as never) as Record<string, unknown>;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_k");
    expect(params).not.toHaveProperty("top_p");
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toEqual({ effort: "low" });
  });
});

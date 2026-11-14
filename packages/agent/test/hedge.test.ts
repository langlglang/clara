import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assistant, AssistantResult } from "../src/assistant.js";
import { createHedgedAssistant } from "../src/hedge.js";
import { state } from "./fixtures.js";

/** An assistant that answers with `result` after `ms` of (fake) time, and records whether it was cancelled. */
const after = (ms: number, result: { ok: true } | { ok: false; reason: "model_error" | "refusal" | "timeout" }, model: string): Assistant & { cancelled: boolean } => {
  const self = {
    cancelled: false,
    reply: (_s: unknown, _l: unknown, _w: unknown, _limit: unknown, signal?: AbortSignal) =>
      new Promise<AssistantResult>((resolve) => {
        const timer = setTimeout(() => resolve({ ...(result.ok ? { ok: true, reply: { transcript: "x", reply: "", action: null } } : result), attempts: 1, ms, model } as AssistantResult), ms);
        signal?.addEventListener("abort", () => {
          self.cancelled = true;
          clearTimeout(timer);
        });
      }),
  };
  return self as Assistant & { cancelled: boolean };
};
const ok = { ok: true } as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Runs a hedged reply on the fake clock; returns the result and the fake time it took. */
async function run(main: Assistant, backup: Assistant, backupAfterMs = 2_500, limitMs = 6_000) {
  const started = Date.now();
  let done: AssistantResult | undefined;
  void createHedgedAssistant({ main, backup, backupAfterMs })
    .reply(state, "en", "x", limitMs)
    .then((r) => (done = r));
  while (!done) await vi.advanceTimersByTimeAsync(10);
  return { result: done, ms: Date.now() - started };
}

describe("createHedgedAssistant (fake clock)", () => {
  it("uses the main answer when it arrives before 2.5 s, even if the backup was faster", async () => {
    const backup = after(300, ok, "backup");
    const { result, ms } = await run(after(2_000, ok, "main"), backup);
    expect(result.model).toBe("main");
    expect(ms).toBe(2_000);
    expect(backup.cancelled).toBe(true);
  });

  it("switches to a ready backup answer at exactly 2.5 s", async () => {
    const main = after(5_000, ok, "main");
    const { result, ms } = await run(main, after(1_200, ok, "backup"));
    expect(result.model).toBe("backup");
    expect(ms).toBe(2_500);
    expect(main.cancelled).toBe(true);
  });

  it("after 2.5 s takes whichever answers first", async () => {
    const { result, ms } = await run(after(3_200, ok, "main"), after(3_000, ok, "backup"));
    expect(result.model).toBe("backup");
    expect(ms).toBe(3_000);
  });

  it("uses the backup as soon as the main model fails early", async () => {
    const { result, ms } = await run(after(100, { ok: false, reason: "model_error" }, "main"), after(800, ok, "backup"));
    expect(result.model).toBe("backup");
    expect(ms).toBe(800);
  });

  it("keeps a main-model refusal", async () => {
    const { result } = await run(after(100, { ok: false, reason: "refusal" }, "main"), after(50, ok, "backup"));
    expect(result).toMatchObject({ ok: false, reason: "refusal", model: "main" });
  });

  it("reports the last failure when both fail", async () => {
    const { result } = await run(after(100, { ok: false, reason: "model_error" }, "main"), after(400, { ok: false, reason: "timeout" }, "backup"));
    expect(result).toMatchObject({ ok: false, reason: "timeout", model: "backup" });
  });

  it("switches before the attempt's own limit when that is shorter than 2.5 s", async () => {
    const { result, ms } = await run(after(5_000, ok, "main"), after(500, ok, "backup"), 2_500, 1_500);
    expect(result.model).toBe("backup");
    expect(ms).toBe(1_200);
  });
});

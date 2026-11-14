import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinator, resolveMode } from "../src/coordinator.js";
import type { RunInput } from "../src/runner.js";
import { fakeRides, harness, openSos } from "./helpers.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function recorder() {
  const runs: RunInput[] = [];
  const runner = async (input: RunInput) => {
    runs.push(input);
    input.setPlan([{ content: "look", status: "completed" }]);
  };
  return { runs, runner };
}

describe("mode", () => {
  it("is off without an API key or with CLARA_COORDINATOR=off; rules needs no key", () => {
    expect(resolveMode({})).toBe("off");
    expect(resolveMode({ ANTHROPIC_API_KEY: "  " })).toBe("off");
    expect(resolveMode({ ANTHROPIC_API_KEY: "k", CLARA_COORDINATOR: "off" })).toBe("off");
    expect(resolveMode({ ANTHROPIC_API_KEY: "k" })).toBe("deep_agent");
    expect(resolveMode({ ANTHROPIC_API_KEY: "k", CLARA_COORDINATOR: "on" })).toBe("deep_agent");
    expect(resolveMode({ CLARA_COORDINATOR: "rules" })).toBe("rules");
    expect(resolveMode({ ANTHROPIC_API_KEY: "k" }, false)).toBe("off");
  });

  it("does nothing when disabled", async () => {
    const h = harness();
    const c = createCoordinator({ network: h.net, env: {}, timers: false });
    expect(c.mode).toBe("off");
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getLog(id)).toBeUndefined();
    expect(c.trigger(id, "manual")).toBe(false);
  });
});

describe("triggering", () => {
  it("debounces triggers that arrive together into one run", async () => {
    const h = harness();
    const { runs, runner } = recorder();
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const id = openSos(h);
    expect(c.getLog(id)?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(1_000);
    const alert = h.net.incident(id)!.incident.alerts[0]!;
    h.net.respond(alert.alert_id, alert.volunteer_id, "declined");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(runs).toHaveLength(0); // reset by the second trigger
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toEqual(["incident opened", `${alert.volunteer_name} declined`]);
    const log = c.getLog(id)!;
    expect(log.runs[0]).toMatchObject({ run: 1, outcome: "ok" });
    expect(log.plan).toEqual([{ content: "look", status: "completed" }]);
    expect(log.label).toBe("deep agent");
  });

  it("runs one at a time per incident and queues the next trigger", async () => {
    const h = harness();
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const runs: string[][] = [];
    const runner = async (input: RunInput) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(input.trigger);
      if (runs.length === 1) await new Promise<void>((r) => (release = r));
      active--;
    };
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(c.getLog(id)?.status).toBe("running");
    c.trigger(id, "manual 1");
    c.trigger(id, "manual 2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(runs).toEqual([["incident opened"], ["manual 1", "manual 2"]]);
    expect(maxActive).toBe(1);
  });

  it("stops after the run limit", async () => {
    const h = harness();
    const { runs, runner } = recorder();
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const id = openSos(h);
    for (let i = 0; i < 15; i++) {
      c.trigger(id, `t${i}`);
      await vi.advanceTimersByTimeAsync(3_100);
    }
    expect(runs).toHaveLength(10);
    expect(c.getLog(id)).toMatchObject({ status: "stopped", stopped_reason: "Run limit reached (10 runs)." });
    expect(c.trigger(id, "more")).toBe(false);
  });

  it("triggers on escalation level change and periodically while open", async () => {
    const h = harness();
    const { runs, runner } = recorder();
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(runs).toHaveLength(1);
    h.advance(30_000);
    c.check();
    expect(c.getLog(id)?.status).toBe("idle");
    h.advance(16_000); // 46 s since the run: periodic
    c.check();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(runs.at(-1)!.trigger).toEqual(["periodic check"]);
    h.advance(16_000); // 62 s after opening: next wave
    c.check();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(runs.at(-1)!.trigger).toEqual(["escalation: next wave"]);
  });

  it("stops planning when the incident closes", async () => {
    const h = harness();
    const { runs, runner } = recorder();
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const id = openSos(h);
    h.advance(61 * 60_000);
    h.net.tick(); // expires
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toHaveLength(0);
    expect(c.getLog(id)).toMatchObject({ status: "stopped", stopped_reason: "Incident closed." });
  });

  it("aborts a run at the deadline without breaking the network", async () => {
    const h = harness();
    let lateResult: unknown;
    let sawAbort = false;
    const runner = async (input: RunInput) => {
      input.signal.addEventListener("abort", () => (sawAbort = true));
      await new Promise((r) => setTimeout(r, 120_000)); // hangs past the deadline
      lateResult = input.tools.alert_volunteers({ volunteer_ids: ["vol-grace"], reason: "late" });
    };
    const logs: string[] = [];
    const c = createCoordinator({ network: h.net, runner, rides: fakeRides(), timers: false, log: (l) => logs.push(l) });
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(3_000 + 60_000 + 10);
    expect(sawAbort).toBe(true);
    const log = c.getLog(id)!;
    expect(log.runs[0]).toMatchObject({ outcome: "timeout" });
    expect(log.status).toBe("idle");
    expect(logs.join("\n")).toMatch(/timeout/);
    // The network keeps working.
    const alert = h.net.incident(id)!.incident.alerts[0]!;
    expect(h.net.respond(alert.alert_id, alert.volunteer_id, "coming").outcome).toBe("answered");
    expect(() => h.net.tick()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lateResult).toMatchObject({ ok: false });
    expect(h.net.incident(id)!.incident.alerts.some((a) => a.volunteer_id === "vol-grace")).toBe(false);
  });

  it("logs a failing runner and keeps going", async () => {
    const h = harness();
    let n = 0;
    const runner = async () => {
      n++;
      throw new Error("model exploded");
    };
    const c = createCoordinator({ network: h.net, runner, timers: false, log: () => undefined });
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(c.getLog(id)!.runs[0]).toMatchObject({ outcome: "error", error: "model exploded" });
    expect(c.trigger(id, "again")).toBe(true);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(n).toBe(2);
  });

  it("publishes log updates to subscribers", async () => {
    const h = harness();
    const { runner } = recorder();
    const c = createCoordinator({ network: h.net, runner, timers: false });
    const seen: string[] = [];
    c.subscribe((ch) => seen.push(ch.log.status));
    openSos(h);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(seen).toContain("queued");
    expect(seen).toContain("running");
    expect(seen.at(-1)).toBe("idle");
  });
});

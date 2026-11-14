import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBusyError, loadBuilding, startPlan } from "../lib/admin";

const state = globalThis as unknown as { __claraAdmin?: unknown };
const original = state.__claraAdmin;
afterEach(() => { state.__claraAdmin = original; });

describe("Admin planner bounds", () => {
  it("limits concurrent plans and building loads", async () => {
    const releases: Array<(value: null) => void> = [];
    const loadInput = vi.fn(() => new Promise<null>((resolve) => releases.push(resolve)));
    state.__claraAdmin = { placement: { loadInput }, jobs: new Map(), inputs: new Map(), activeLoads: 0 };
    const first = startPlan(1);
    const second = startPlan(2);
    expect(first?.status).toBe("loading");
    expect(second?.status).toBe("loading");
    expect(startPlan(3)).toBeNull();
    const more = [loadBuilding(3), loadBuilding(4)];
    expect(() => loadBuilding(5)).toThrow(AdminBusyError);
    releases.forEach((release) => release(null));
    await Promise.all(more);
    await vi.waitFor(() => expect([first?.status, second?.status]).toEqual(["failed", "failed"]));
  });

  it("keeps at most eight cached building inputs", async () => {
    state.__claraAdmin = { placement: { loadInput: async () => null }, jobs: new Map(), inputs: new Map(), activeLoads: 0 };
    for (let id = 1; id <= 10; id++) await loadBuilding(id);
    expect((state.__claraAdmin as { inputs: Map<number, unknown> }).inputs.size).toBe(8);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNetwork } from "@clara/network";
import { EVENTS_VERSION } from "@clara/contracts";
import { createAutoSupply, stockSku } from "../lib/autoSupply";

const scenario = {
  scenario_id: "severe_bleeding",
  steps: [{ step_id: "tourniquet", item: "TOURNIQUET" }, { step_id: "keep_warm", item: "BLANKET" }, { step_id: "find_wound", item: "SCISSORS" }, { step_id: "start" }],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function show(network: ReturnType<typeof createNetwork>, session: string, step: string) {
  network.ingest({
    schema_version: EVENTS_VERSION,
    events: [{ event_id: randomUUID(), box_id: "box-clinic", session_id: session, occurred_at: new Date().toISOString(), type: "step.shown", scenario_id: "severe_bleeding", step_id: step, source: "voice" }],
  });
}

describe("automatic supply count", () => {
  it("maps scenario items to stocked names", () => {
    expect(stockSku("TOURNIQUET")).toBe("tourniquet");
    expect(stockSku("BLANKET")).toBe("emergency_blanket");
    expect(stockSku("HEMOSTATIC_GAUZE")).toBe("gauze");
    expect(stockSku("SCISSORS")).toBeNull();
  });

  it("counts one item per guided step per session, only for stocked items", async () => {
    const network = createNetwork();
    network.seedDemo();
    createAutoSupply({ network, scenarios: [scenario] });
    const before = network.supplies("box-clinic")!.items.find((i) => i.sku === "tourniquet")!.used;
    const s1 = randomUUID();
    show(network, s1, "tourniquet");
    show(network, s1, "tourniquet"); // shown again (repeat): still one
    show(network, s1, "keep_warm");
    show(network, s1, "find_wound"); // scissors aren't stocked
    show(network, s1, "start"); // no item
    await flush();
    const ledger = network.supplies("box-clinic")!;
    expect(ledger.items.find((i) => i.sku === "tourniquet")!.used).toBe(before + 1);
    expect(ledger.items.find((i) => i.sku === "emergency_blanket")!.used).toBe(1);
    show(network, randomUUID(), "tourniquet"); // a new emergency uses another
    await flush();
    expect(network.supplies("box-clinic")!.items.find((i) => i.sku === "tourniquet")!.used).toBe(before + 2);
  });
});

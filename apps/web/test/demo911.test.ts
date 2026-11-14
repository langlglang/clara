import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNetwork } from "@clara/network";
import { EVENTS_VERSION } from "@clara/contracts";
import { briefing, briefingLines, createDemo911, demo911Target, demo911Twiml } from "../lib/demo911";

const twilio = { accountSid: "AC" + "0".repeat(32), authToken: "token", from: "+15550000000" };

function sos(network: ReturnType<typeof createNetwork>, boxId = "box-clinic") {
  const session = randomUUID();
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const opened = { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(3), type: "sos.opened" as const, need: "bleeding" as const, source: "touch" as const };
  network.ingest({
    schema_version: EVENTS_VERSION,
    events: [
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(0), type: "box.opened" },
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(1), type: "report.heard", text: "his leg is bleeding a lot" },
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(2), type: "timer.started", timer: "tourniquet", step_id: "tighten" },
      opened,
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(4), type: "emergency.context", task_id: opened.event_id, location: { kind: "configured_address", address: "1455 California Ave" } },
    ],
  });
}

describe("demo 911 call", () => {
  it("refuses emergency numbers and bad formats", () => {
    for (const n of ["911", "+1911", "+19115551234", "112", "+112", "999", "+999", "000", "5551234567", "", undefined]) expect(demo911Target(n)).toBeNull();
    expect(demo911Target("+1 (737) 258-3742")).toBe("+17372583742");
  });

  it("calls the demo dispatcher once per incident with a briefing from the box's events", async () => {
    const network = createNetwork();
    network.seedDemo();
    const sent: Array<{ url: string; body: string }> = [];
    const fetchFake = async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ sid: "CA123" }), { status: 201 });
    };
    const d = createDemo911({ network, twilio, number: "+17372583742", fetch: fetchFake, timers: false, log: () => {} });
    sos(network);
    const call = await d.fire("box-clinic");
    expect(call?.status).toBe("placed");
    expect(await d.fire("box-clinic")).toBeNull(); // once per incident
    expect(sent).toHaveLength(1);
    const params = new URLSearchParams(sent[0]!.body);
    expect(params.get("To")).toBe("+17372583742");
    const twiml = params.get("Twiml")!;
    expect(twiml).toContain("simulated 911 call");
    expect(twiml).toContain("1455 California Ave");
    expect(twiml).toContain("not a live GPS fix");
    expect(twiml).not.toMatch(/Room 101|Clinic tent/);
    expect(twiml).toContain("his leg is bleeding a lot");
    expect(twiml).toContain("tourniquet guidance timer");
    expect(twiml).toContain("application is unconfirmed");
    expect(twiml).not.toMatch(/tourniquet (?:was )?applied|tourniquet on/i);
    expect(twiml).toContain("one-time briefing was assembled");
    expect(twiml).toContain("later updates are not included");
    expect(twiml).not.toMatch(/help is on the way|ambulance is coming/i);
  });

  it("uses only the SOS-linked address, never an unrelated context or seeded directions", () => {
    const network = createNetwork();
    network.seedDemo();
    sos(network);
    const open = network.openIncidentForBox("box-clinic")!;
    network.ingest({ schema_version: EVENTS_VERSION, events: [
      { event_id: randomUUID(), box_id: "box-clinic", session_id: open.incident.session_id, occurred_at: new Date().toISOString(), type: "emergency.context", task_id: randomUUID(), location: { kind: "configured_address", address: "Wrong address" } },
    ] });
    const text = briefing(network, "box-clinic", new Date())!;
    const page = briefingLines(network, open.incident.incident_id)!;
    expect(text).toContain("1455 California Ave");
    expect(page.lines.find((line) => line.kind === "location")?.text).toContain("1455 California Ave");
    expect(page.lines.find((line) => line.kind === "timer")?.text).toContain("application is unconfirmed");
    expect(text).not.toContain("Wrong address");
    expect(text).not.toMatch(/Room 101|Clinic tent/);
  });

  it("asks for location when no configured address arrived before the briefing", () => {
    const network = createNetwork();
    network.seedDemo();
    const session = randomUUID();
    const at = new Date().toISOString();
    network.ingest({ schema_version: EVENTS_VERSION, events: [
      { event_id: randomUUID(), box_id: "box-clinic", session_id: session, occurred_at: at, type: "box.opened" },
      { event_id: randomUUID(), box_id: "box-clinic", session_id: session, occurred_at: at, type: "sos.opened", need: "general", source: "touch" },
    ] });
    const text = briefing(network, "box-clinic", new Date())!;
    expect(text).toContain("no configured address available");
    expect(text).not.toMatch(/Room 101|Clinic tent|1455 California Ave/);
  });

  it("only logs when the number or Twilio is missing", async () => {
    const network = createNetwork();
    network.seedDemo();
    const d = createDemo911({ network, twilio: null, number: "+17372583742", timers: false, log: () => {} });
    sos(network);
    expect((await d.fire("box-clinic"))?.status).toBe("not_configured");
    expect(d.configured).toBe(false);
  });

  it("escapes the briefing in TwiML", () => {
    expect(demo911Twiml("a < b & c")).toContain("a &lt; b &amp; c");
  });
});

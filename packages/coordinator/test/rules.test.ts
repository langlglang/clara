import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinator } from "../src/coordinator.js";
import { pickCandidates } from "../src/rules.js";
import { fakeRides, harness, heartbeat, openSos } from "./helpers.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("rules planner", () => {
  it("plans, alerts a replacement after a decline, and notes it", async () => {
    const h = harness();
    heartbeat(h, "box-clinic", "box-room-101", "box-water-point");
    const c = createCoordinator({ network: h.net, rides: fakeRides(), env: { CLARA_COORDINATOR: "rules" }, timers: false });
    expect(c.mode).toBe("rules");
    const id = openSos(h);
    await vi.advanceTimersByTimeAsync(3_100);
    let log = c.getLog(id)!;
    expect(log.label).toBe("rules");
    expect(log.plan.length).toBeGreaterThanOrEqual(5);
    expect(log.plan.every((p) => p.status === "completed")).toBe(true);
    expect(log.actions.filter((a) => a.kind === "act" && a.tool === "alert_volunteers")).toHaveLength(0); // first wave just went out
    expect(log.notes).toHaveLength(1);
    expect(log.notes[0]!.text).toMatch(/Nobody has accepted yet/);

    const amina = h.net.incident(id)!.incident.alerts.find((a) => a.volunteer_name === "Amina")!;
    h.net.respond(amina.alert_id, amina.volunteer_id, "declined");
    await vi.advanceTimersByTimeAsync(3_100);
    log = c.getLog(id)!;
    const alert = log.actions.find((a) => a.tool === "alert_volunteers")!;
    expect(alert).toMatchObject({ ok: true, agent: "rules", reason: "Amina declined" });
    expect(alert.result).toMatch(/Alerted Grace/); // the doctor goes first
    expect(log.extra_alerts).toBe(1);
    expect(log.notes.at(-1)!.text).toMatch(/Amina declined.*alerted Grace \(doctor, 0\.\d+ km\)/);
    expect(h.net.comingLine("box-clinic")).toBeNull(); // nobody accepted, nothing said
  });

  it("does not propose a ride from a guidance timer, asks for a kit after escalation, and holds once someone is coming", async () => {
    const h = harness();
    heartbeat(h, "box-clinic", "box-room-101", "box-water-point");
    const rides = fakeRides();
    const c = createCoordinator({ network: h.net, rides, env: { CLARA_COORDINATOR: "rules" }, timers: false });
    const id = openSos(h, "box-clinic", { tourniquet: true, askNearby: true });
    h.advance(62_000);
    c.check();
    await vi.advanceTimersByTimeAsync(3_100);
    let log = c.getLog(id)!;
    expect(log.actions.find((a) => a.tool === "request_kit")).toMatchObject({ ok: true, args: "box-room-101" });
    expect(log.actions.find((a) => a.tool === "propose_ride")).toBeUndefined();
    const yusuf = h.net.incident(id)!.incident.alerts.find((a) => a.volunteer_name === "Yusuf")!;
    h.net.respond(yusuf.alert_id, yusuf.volunteer_id, "coming");
    c.trigger(id, "manual");
    await vi.advanceTimersByTimeAsync(3_100);
    log = c.getLog(id)!;
    expect(log.actions.filter((a) => a.tool === "propose_ride")).toHaveLength(0);
    expect(rides.forIncident(id)?.offers ?? []).toEqual([]);
    expect(log.notes.at(-1)!.text).toMatch(/^Run 2: Yusuf is responding. No action needed.$/);
  });

  it("flags the dispatcher when nobody replies after everyone was alerted", async () => {
    const h = harness();
    const c = createCoordinator({ network: h.net, env: { CLARA_COORDINATOR: "rules" }, timers: false });
    const id = openSos(h);
    h.advance(121_000);
    h.net.tick();
    c.check();
    await vi.advanceTimersByTimeAsync(3_100);
    const log = c.getLog(id)!;
    expect(log.flags.map((f) => f.reason)).toEqual(["No reply after everyone with the skill was alerted. Call for help another way."]);
  });

  it("prefers medical skills within reach", () => {
    const c = (id: string, skills: string[], eta: number) => ({ volunteer_id: id, name: id, skills, matching_skills: skills, distance_km: eta / 10, eta_minutes: eta });
    expect(pickCandidates([c("a", ["first_aid"], 3), c("b", ["doctor"], 4), c("d", ["nurse"], 40)], 2).map((x) => x.volunteer_id)).toEqual(["b", "a"]);
  });
});

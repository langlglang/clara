import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/tools.js";
import { fakeRides, harness, heartbeat, layerFor, openSos, type Harness } from "./helpers.js";

/** Extra fictional first-aiders next to the clinic so the per-incident cap can be reached. */
function addHelpers(h: Harness, n: number) {
  for (let i = 0; i < n; i++)
    h.net.registerVolunteer({ volunteer_id: `vol-extra-${i}`, name: `Extra ${i}`, skills: ["first_aid"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.3501 + i * 0.0001, lng: -74.6601 }, available: true, channel: "app" });
}

describe("tool limits", () => {
  it("alert_volunteers rejects unknown and already-alerted ids and sends nothing", () => {
    const h = harness();
    const id = openSos(h);
    const { tools, state } = layerFor(h, id);
    const firstWave = h.net.incident(id)!.incident.alerts.map((a) => a.volunteer_id);
    const before = h.net.incident(id)!.incident.alerts.length;

    const unknown = tools.alert_volunteers({ volunteer_ids: ["vol-grace", "vol-ghost"], reason: "test" });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.error).toMatch(/vol-ghost \(not a listed candidate\)/);
    const again = tools.alert_volunteers({ volunteer_ids: [firstWave[0]!], reason: "test" });
    expect(!again.ok && again.error).toMatch(/already alerted/);
    const unavailable = tools.alert_volunteers({ volunteer_ids: ["vol-daniel"], reason: "test" });
    expect(unavailable.ok).toBe(false);
    expect(tools.alert_volunteers({ volunteer_ids: ["vol-grace"], reason: "" }).ok).toBe(false);
    expect(h.net.incident(id)!.incident.alerts.length).toBe(before);
    expect(state.log.extra_alerts).toBe(0);

    const good = tools.alert_volunteers({ volunteer_ids: ["vol-grace"], reason: "Amina declined" });
    expect(good.ok).toBe(true);
    expect(h.net.incident(id)!.incident.alerts.find((a) => a.volunteer_id === "vol-grace")?.state).toBe("sent");
    expect(state.log.extra_alerts).toBe(1);
    expect(state.log.actions.at(-1)).toMatchObject({ tool: "alert_volunteers", kind: "act", ok: true, reason: "Amina declined", result: "Alerted Grace" });
  });

  it(`alert_volunteers allows at most ${LIMITS.ALERTS_PER_CALL} per call and ${LIMITS.EXTRA_ALERTS_PER_INCIDENT} extra per incident`, () => {
    const h = harness();
    addHelpers(h, 10);
    const id = openSos(h);
    const { tools, state } = layerFor(h, id);
    const ids = () => h.net.candidates(id).map((c) => c.volunteer.volunteer_id);

    const four = tools.alert_volunteers({ volunteer_ids: ids().slice(0, 4), reason: "r" });
    expect(!four.ok && four.error).toMatch(/At most 3/);
    expect(tools.alert_volunteers({ volunteer_ids: ids().slice(0, 3), reason: "r" }).ok).toBe(true);
    expect(tools.alert_volunteers({ volunteer_ids: ids().slice(0, 3), reason: "r" }).ok).toBe(true);
    expect(state.log.extra_alerts).toBe(6);
    const seventh = tools.alert_volunteers({ volunteer_ids: ids().slice(0, 1), reason: "r" });
    expect(!seventh.ok && seventh.error).toMatch(/Only 0 extra alert/);
    expect(h.net.incident(id)!.incident.alerts).toHaveLength(3 + 6);
  });

  it("request_kit refuses offline, far, own and repeated boxes", () => {
    const h = harness();
    const id = openSos(h);
    const { tools } = layerFor(h, id);
    // Boxes start offline (no heartbeat yet).
    const offline = tools.request_kit({ from_box_id: "box-room-101", reason: "second kit" });
    expect(!offline.ok && offline.error).toMatch(/offline/);
    heartbeat(h, "box-room-101", "box-water-point", "box-clinic");
    const far = tools.request_kit({ from_box_id: "box-water-point", reason: "second kit" });
    expect(!far.ok && far.error).toMatch(/km away/);
    expect(tools.request_kit({ from_box_id: "box-clinic", reason: "x" }).ok).toBe(false);
    expect(tools.request_kit({ from_box_id: "box-nope", reason: "x" }).ok).toBe(false);
    const pushes: string[] = [];
    h.net.subscribe((c) => c.kind === "push" && c.push.type === "nearby.emergency" && pushes.push(c.box_id));
    expect(tools.request_kit({ from_box_id: "box-room-101", reason: "second kit" }).ok).toBe(true);
    expect(pushes).toEqual(["box-room-101"]);
    expect(tools.request_kit({ from_box_id: "box-room-101", reason: "again" }).ok).toBe(false);
  });

  it("propose_ride opens a plan but never approves or offers", () => {
    const h = harness();
    const id = openSos(h);
    const rides = fakeRides();
    const { tools, state } = layerFor(h, id, { rides });
    expect(tools.propose_ride({ driver_id: "vol-moto", reason: "fast" }).ok).toBe(false); // motorbike: not suitable
    expect(tools.propose_ride({ driver_id: "vol-ghost", reason: "x" }).ok).toBe(false);
    const r = tools.propose_ride({ driver_id: "vol-samir", reason: "Tourniquet on" });
    expect(r).toMatchObject({ ok: true, status: "waiting_for_dispatcher" });
    expect(rides.forIncident(id)!.state).toBe("planning");
    expect(rides.forIncident(id)!.offers).toEqual([]);
    expect(rides.calls.every((c) => c.startsWith("request:"))).toBe(true);
    expect(state.rideProposals).toHaveLength(1);
    expect(tools.propose_ride({ driver_id: "vol-samir", reason: "again" }).ok).toBe(false);
    expect(layerFor(h, id).tools.propose_ride({ driver_id: "vol-samir", reason: "x" }).ok).toBe(false); // no rides adapter
  });

  it("post_dispatch_note caps length; flags dedupe", () => {
    const h = harness();
    const id = openSos(h);
    const { tools, state } = layerFor(h, id);
    expect(tools.post_dispatch_note({ text: "x".repeat(LIMITS.NOTE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(tools.post_dispatch_note({ text: "  " }).ok).toBe(false);
    expect(tools.post_dispatch_note({ text: "x".repeat(LIMITS.NOTE_MAX_CHARS) }).ok).toBe(true);
    expect(state.log.notes).toHaveLength(1);
    expect(tools.flag_for_dispatcher({ reason: "Nobody left" }).ok).toBe(true);
    expect(tools.flag_for_dispatcher({ reason: "Nobody left" }).ok).toBe(false);
    expect(state.log.flags).toHaveLength(1);
  });

  it("refuses every action after the deadline and on closed incidents", () => {
    const h = harness();
    const id = openSos(h);
    const controller = new AbortController();
    controller.abort();
    const { tools } = layerFor(h, id, { signal: controller.signal });
    const r = tools.alert_volunteers({ volunteer_ids: ["vol-grace"], reason: "late" });
    expect(!r.ok && r.error).toMatch(/deadline/);
    expect(tools.get_incident().ok).toBe(false);

    h.advance(61 * 60_000);
    h.net.tick();
    const closed = layerFor(h, id).tools.alert_volunteers({ volunteer_ids: ["vol-grace"], reason: "x" });
    expect(!closed.ok && closed.error).toMatch(/closed/);
  });

  it("read tools describe the incident, candidates and kits as data", () => {
    const h = harness();
    heartbeat(h, "box-room-101");
    const id = openSos(h);
    const { tools } = layerFor(h, id);
    const inc = tools.get_incident() as { ok: true; need: string; alerts: unknown[]; report_token?: string };
    expect(inc.need).toBe("bleeding");
    expect(inc.alerts).toHaveLength(3);
    expect(JSON.stringify(inc)).not.toContain(h.net.incident(id)!.incident.report_token);
    const cands = tools.list_candidates() as { ok: true; candidates: { volunteer_id: string; languages: string[] }[] };
    expect(cands.candidates.map((c) => c.volunteer_id)).toContain("vol-grace");
    const kits = tools.get_nearby_kits() as { ok: true; kits: { box_id: string; requestable: boolean }[] };
    expect(kits.kits.find((k) => k.box_id === "box-room-101")?.requestable).toBe(true);
    expect(kits.kits.find((k) => k.box_id === "box-water-point")?.requestable).toBe(false);
  });
});

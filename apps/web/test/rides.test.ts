import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sequentialIds } from "@clara/network";
import { POST as respond } from "../app/api/alerts/[id]/respond/route";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { POST as postMessage } from "../app/api/incidents/[id]/messages/route";
import { POST as requestRide } from "../app/api/rides/route";
import { POST as approve } from "../app/api/rides/[id]/approve/route";
import { POST as answer } from "../app/api/rides/[id]/answer/route";
import { POST as reassign } from "../app/api/rides/[id]/reassign/route";
import { POST as availability } from "../app/api/volunteers/[id]/availability/route";
import { GET as getInbox } from "../app/api/volunteers/[id]/inbox/route";
import { createRuntime, setRuntime, type AppChange, type Runtime } from "../lib/server";
import type { RideView } from "../lib/rides";
import type { InboxResponse } from "../lib/views";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let now = T0;
let rt: Runtime;
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const post = (url: string, body?: unknown) =>
  new Request(`http://test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  now = T0;
  rt = createRuntime({ clock: () => new Date(now), ids: sequentialIds(), timers: false, env: { CLARA_MODEL: "stub", CLARA_AMBULANCE_ETA_MIN: "35" } });
  setRuntime(rt);
});
afterEach(() => setRuntime(null));

async function openIncident() {
  const res = await demoSos(post("/api/demo/sos?box=box-clinic&need=bleeding"));
  return ((await res.json()) as { incident: { incident_id: string; alerts: { alert_id: string; volunteer_id: string }[] } }).incident;
}

async function newRide(incidentId: string) {
  const res = await requestRide(post("/api/rides", { incident_id: incidentId, note: "1 adult, can sit up" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { ride: RideView }).ride;
}

describe("rides", () => {
  it("suggests the closest suitable free driver with reasons, and backups", async () => {
    const incident = await openIncident();
    const ride = await newRide(incident.incident_id);
    // Tomas drives 1.4 km in 3 min; Samir walks 0.4 km in 6; Priya is 7.8 km out.
    expect(ride.suggested?.driver_id).toBe("vol-tomas");
    expect(ride.suggested?.suitable).toBe(true);
    expect(ride.suggested?.reasons[0]).toMatch(/closest free driver/);
    expect(ride.backups.map((b) => b.driver_id)).toEqual(["vol-samir", "vol-priya"]);
    expect(ride.hospital_minutes).toBeGreaterThan(0);
    // Asking again returns the same ride.
    expect((await newRide(incident.incident_id)).ride_id).toBe(ride.ride_id);
  });

  it("one accept wins; the other driver gets taken; the box hears a template line only after the accept", async () => {
    const pushes: AppChange[] = [];
    rt.subscribe((c) => pushes.push(c));
    const incident = await openIncident();
    const ride = await newRide(incident.incident_id);
    expect((await approve(post(`/api/rides/${ride.ride_id}/approve`, {}), params({ id: ride.ride_id }))).status).toBe(200);
    expect((await approve(post(`/api/rides/${ride.ride_id}/approve`, { driver_id: "vol-samir" }), params({ id: ride.ride_id }))).status).toBe(200);
    expect(pushes.some((c) => c.kind === "push")).toBe(false);

    // The driver sees the offer in the inbox.
    const inbox = (await (await getInbox(new Request("http://test/x"), params({ id: "vol-tomas" }))).json()) as InboxResponse;
    expect(inbox.rides).toHaveLength(1);
    expect(inbox.rides[0]!.my_offer?.state).toBe("offered");
    expect(inbox.rides[0]!.ambulance_eta_min).toBe(35);

    expect((await answer(post(`/api/rides/${ride.ride_id}/answer`, { driver_id: "vol-lena", action: "accept" }), params({ id: ride.ride_id }))).status).toBe(403);
    const won = await answer(post(`/api/rides/${ride.ride_id}/answer`, { driver_id: "vol-samir", action: "accept" }), params({ id: ride.ride_id }));
    expect(won.status).toBe(200);
    const late = await answer(post(`/api/rides/${ride.ride_id}/answer`, { driver_id: "vol-tomas", action: "accept" }), params({ id: ride.ride_id }));
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { outcome: string } }).error.outcome).toBe("taken");
    const box = pushes.filter((c) => c.kind === "push");
    expect(box).toHaveLength(1);
    expect(box[0]!.kind === "push" && box[0]!.push.type === "responder.message" && box[0]!.push.text).toMatch(/^Samir, a volunteer driver, accepted/);
    expect(rt.rides.get(ride.ride_id)!.offers.find((f) => f.driver_id === "vol-tomas")?.state).toBe("lost");
  });

  it("offers expire after 60 s, and reassign moves to the next driver", async () => {
    const incident = await openIncident();
    const ride = await newRide(incident.incident_id);
    await approve(post(`/api/rides/${ride.ride_id}/approve`, {}), params({ id: ride.ride_id }));
    now += 61_000;
    rt.rides.tick(new Date(now));
    expect(rt.rides.get(ride.ride_id)!.offers[0]!.state).toBe("expired");
    expect(rt.rides.get(ride.ride_id)!.state).toBe("planning");
    const expired = await answer(post(`/api/rides/${ride.ride_id}/answer`, { driver_id: "vol-tomas", action: "accept" }), params({ id: ride.ride_id }));
    expect(expired.status).toBe(409);

    const before = rt.rides.get(ride.ride_id)!.suggested?.driver_id;
    const r = (await (await reassign(post(`/api/rides/${ride.ride_id}/reassign`), params({ id: ride.ride_id }))).json()) as { ride: RideView };
    expect(r.ride.suggested?.driver_id).not.toBe(before);
  });
});

describe("messages and availability", () => {
  it("lets only a coming volunteer message the box", async () => {
    const incident = await openIncident();
    const amina = incident.alerts.find((a) => a.volunteer_id === "vol-amina")!;
    const send = () => postMessage(post(`/api/incidents/${incident.incident_id}/messages`, { volunteer_id: "vol-amina", text: "Keep pressure, I'm close" }), params({ id: incident.incident_id }));
    expect((await send()).status).toBe(403);
    await respond(post(`/api/alerts/${amina.alert_id}/respond`, { volunteer_id: "vol-amina", action: "coming" }), params({ id: amina.alert_id }));
    expect((await send()).status).toBe(201);
    expect(rt.messages.get(incident.incident_id)).toHaveLength(1);
  });

  it("toggles availability", async () => {
    const res = await availability(post("/api/volunteers/vol-amina/availability", { available: false }), params({ id: "vol-amina" }));
    expect(((await res.json()) as { volunteer: { available: boolean } }).volunteer.available).toBe(false);
    expect((await availability(post("/api/volunteers/vol-amina/availability", { available: "no" }), params({ id: "vol-amina" }))).status).toBe(400);
  });
});

describe("requestNow (the coordinator's request_ride)", () => {
  it("previews the hospital and drivers without opening a ride", async () => {
    const incident = await openIncident();
    const p = rt.rides.preview(incident.incident_id)!;
    expect(p.hospital?.name).toMatch(/fictional/);
    expect(p.hospital!.drive_minutes).toBeGreaterThan(0);
    expect(p.seats_needed).toBe(1);
    expect(p.drivers.find((d) => d.suitable)?.driver_id).toBe("vol-tomas");
    expect(p.drivers.every((d) => typeof d.carries_lying_down === "boolean")).toBe(true);
    expect(rt.rides.forIncident(incident.incident_id)).toBeUndefined();
  });

  it("opens the ride and offers it to the two best drivers at once; first accept wins; refuses an active ride", async () => {
    const changes: AppChange[] = [];
    rt.subscribe((c) => changes.push(c));
    const incident = await openIncident();
    const r = rt.rides.requestNow(incident.incident_id, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.offered_to).toEqual(["Tomas", "Samir"]);
    expect(r.ride.state).toBe("offered");
    expect(r.ride.offers.map((f) => f.state)).toEqual(["offered", "offered"]);
    // No words at the box before an accept.
    expect(changes.some((c) => c.kind === "push")).toBe(false);
    expect(rt.rides.requestNow(incident.incident_id, null)).toEqual({ ok: false, error: "active" });

    const inbox = (await (await getInbox(new Request("http://test/x"), params({ id: "vol-samir" }))).json()) as InboxResponse;
    expect(inbox.rides[0]?.my_offer?.state).toBe("offered");
    const won = await answer(post(`/api/rides/${r.ride.ride_id}/answer`, { driver_id: "vol-samir", action: "accept" }), params({ id: r.ride.ride_id }));
    expect(won.status).toBe(200);
    const ride = rt.rides.get(r.ride.ride_id)!;
    expect(ride.winner?.driver_id).toBe("vol-samir");
    expect(ride.offers.find((f) => f.driver_id === "vol-tomas")?.state).toBe("lost");
    expect(ride.winner!.pickup_minutes).toBeGreaterThan(1); // Samir walks 0.4 km
    // Time to care then follows the accepted driver.
    expect(rt.rides.preview(incident.incident_id)!.drivers.map((d) => d.driver_id)).toEqual(["vol-samir"]);
    expect(changes.some((c) => c.kind === "push")).toBe(true);
  });

  it("reuses a planning ride with no offers, and refuses unknown incidents", async () => {
    const incident = await openIncident();
    const plan = await newRide(incident.incident_id);
    const r = rt.rides.requestNow(incident.incident_id, null);
    expect(r.ok && r.ride.ride_id).toBe(plan.ride_id);
    rt.rides.cancel(plan.ride_id);
    expect(rt.rides.requestNow("inc-missing", null)).toEqual({ ok: false, error: "not_found" });
  });
});

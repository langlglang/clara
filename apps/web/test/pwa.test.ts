import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sequentialIds } from "@clara/network";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { POST as signUp } from "../app/api/volunteers/route";
import { GET as getVolunteer, PATCH as patchVolunteer } from "../app/api/volunteers/[id]/route";
import { DELETE as deletePush, POST as savePush } from "../app/api/volunteers/[id]/push/route";
import { POST as testPush } from "../app/api/volunteers/[id]/push/test/route";
import { GET as pushKey } from "../app/api/push/key/route";
import { POST as gather } from "../app/api/twilio/gather/route";
import { GET as getInbox } from "../app/api/volunteers/[id]/inbox/route";
import { CALL_AFTER_MS } from "../lib/calls";
import { inQuietHours, maskPhone } from "../lib/alertText";
import type { PushSender, PushSubscriptionJson } from "../lib/push";
import { createRuntime, setRuntime, type Runtime, type WebEnv } from "../lib/server";
import { callTwiml, twilioSignature, validTwilioSignature } from "../lib/twilio";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let now = T0;
let rt: Runtime;
let sent: { endpoint: string; payload: { title: string; body: string; tag: string; actions?: boolean; data: Record<string, unknown> } }[];
let deadEndpoints: Set<string>;
let twilioCalls: { url: string; body: URLSearchParams }[];

const BASE_ENV: WebEnv = { CLARA_MODEL: "stub", VAPID_PUBLIC_KEY: "test-public-key", VAPID_PRIVATE_KEY: "test-private-key", VAPID_SUBJECT: "mailto:test@example.com" };
const TWILIO_ENV: WebEnv = { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "secret-token", TWILIO_FROM_NUMBER: "+15550000000", PUBLIC_BASE_URL: "https://clara.test" };

const fakeSender: PushSender = async (sub, payload) => {
  if (deadEndpoints.has(sub.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return { statusCode: 201 };
};
const fakeFetch = async (url: string, init: RequestInit) => {
  twilioCalls.push({ url, body: new URLSearchParams(String(init.body)) });
  return new Response(JSON.stringify({ sid: `CA${twilioCalls.length}` }), { status: 201 });
};

function start(extraEnv: WebEnv = {}) {
  rt?.stop();
  rt = createRuntime({ clock: () => new Date(now), ids: sequentialIds(), timers: false, env: { ...BASE_ENV, ...extraEnv }, pushSender: fakeSender, fetch: fakeFetch });
  setRuntime(rt);
}

beforeEach(() => {
  now = T0;
  sent = [];
  deadEndpoints = new Set();
  twilioCalls = [];
  start();
});
afterEach(() => setRuntime(null));

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://test${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const sub = (n: number): PushSubscriptionJson => ({ endpoint: `https://push.example.com/sub/${n}`, keys: { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", auth: "tBHItJI5svbpez7KI4CCXg" } });

/** A nurse right next to the clinic box (first in the first wave). */
async function joinNurse(extra: Record<string, unknown> = {}) {
  const res = await signUp(req("POST", "/api/volunteers", { name: "Test Nurse", skills: ["nurse"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.3501, lng: -74.6601 }, channel: "app", ...extra }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { volunteer: { volunteer_id: string; skills: string[] } }).volunteer;
}

async function openSos() {
  const res = await demoSos(req("POST", "/api/demo/sos?box=box-clinic&need=bleeding"));
  expect(res.status).toBe(201);
  return ((await res.json()) as { incident: { incident_id: string; alerts: { alert_id: string; volunteer_id: string }[] } }).incident;
}

describe("push subscriptions", () => {
  it("serves the VAPID public key and saves, counts and removes devices", async () => {
    expect(((await (await pushKey()).json()) as { publicKey: string }).publicKey).toBe("test-public-key");
    const v = await joinNurse();
    const p = params({ id: v.volunteer_id });
    expect((await savePush(req("POST", "/x", { subscription: sub(1) }), p)).status).toBe(201);
    expect(((await (await savePush(req("POST", "/x", { subscription: sub(2) }), p)).json()) as { devices: number }).devices).toBe(2);
    // The same device again replaces itself.
    expect(((await (await savePush(req("POST", "/x", { subscription: sub(2) }), p)).json()) as { devices: number }).devices).toBe(2);
    expect((await savePush(req("POST", "/x", { subscription: { endpoint: "http://insecure", keys: { p256dh: "x", auth: "y" } } }), p)).status).toBe(400);
    expect((await savePush(req("POST", "/x", { subscription: sub(1) }), params({ id: "vol-nobody" }))).status).toBe(404);
    expect(((await (await deletePush(req("DELETE", "/x", { endpoint: sub(1).endpoint }), p)).json()) as { devices: number }).devices).toBe(1);
  });

  it("pushes each new alert to every device of the volunteer, without patient names, and drops dead subscriptions", async () => {
    const v = await joinNurse();
    rt.push.save(v.volunteer_id, sub(1));
    rt.push.save(v.volunteer_id, sub(2));
    deadEndpoints.add(sub(2).endpoint);
    const incident = await openSos();
    await rt.push.idle();
    const alert = incident.alerts.find((a) => a.volunteer_id === v.volunteer_id)!;
    expect(sent).toHaveLength(1);
    const { payload } = sent[0]!;
    expect(payload.title).toBe("EMERGENCY NEARBY");
    expect(payload.body).toMatch(/^Severe bleeding · Clinic tent · \d+ m \(about \d+ min\)\. Can you come\?$/);
    expect(payload.actions).toBe(true);
    expect(payload.data).toMatchObject({ alert_id: alert.alert_id, volunteer_id: v.volunteer_id, incident_id: incident.incident_id });
    expect(payload.body).not.toMatch(/is coming|on the way|help is/i);
    expect(rt.push.devices(v.volunteer_id)).toBe(1);
  });

  it("pushes escalation alerts too, but not during the volunteer's quiet hours", async () => {
    const v = await joinNurse({ location: { lat: 40.358, lng: -74.66 } }); // ~0.9 km: not in the first wave
    rt.push.save(v.volunteer_id, sub(1));
    const incident = await openSos();
    await rt.push.idle();
    expect(incident.alerts.some((a) => a.volunteer_id === v.volunteer_id)).toBe(false);
    expect(sent).toHaveLength(0);
    now += 121_000;
    rt.network.tick();
    await rt.push.idle();
    expect(sent.map((s) => s.payload.data.volunteer_id)).toContain(v.volunteer_id);

    // Quiet hours 18:00–20:00 UTC cover T0 (19:00Z): no push.
    sent = [];
    const q = await joinNurse({ quiet_hours: { start: "18:00", end: "20:00", tz: "UTC" } });
    rt.push.save(q.volunteer_id, sub(3));
    rt.network.alertVolunteers(incident.incident_id, [q.volunteer_id]);
    await rt.push.idle();
    expect(sent).toHaveLength(0);
  });

  it("sends a labeled test alert, refuses without a device, and rate-limits", async () => {
    const v = await joinNurse();
    const p = params({ id: v.volunteer_id });
    expect((await testPush(req("POST", "/x"), p)).status).toBe(409);
    rt.push.save(v.volunteer_id, sub(1));
    const ok = await testPush(req("POST", "/x"), p);
    expect(ok.status).toBe(200);
    expect(sent[0]!.payload.title).toBe("CLARA TEST ALERT");
    expect(sent[0]!.payload.actions).toBeUndefined();
    expect((await testPush(req("POST", "/x"), p)).status).toBe(409);
  });

  it("gives up on a push service that doesn't answer", async () => {
    const { createPushBook } = await import("../lib/push");
    const book = createPushBook({ vapid: { publicKey: "a", privateKey: "b", subject: "mailto:x@y.z", source: "env" }, sender: () => new Promise(() => {}), timeoutMs: 20, log: () => {} });
    book.save("v", sub(1));
    expect(await book.send("v", { title: "t", body: "b", tag: "x", data: {} })).toEqual({ sent: 0, failed: 1, removed: 0 });
  });
});

describe("phone-call fallback", () => {
  const consenting = { phone: "+15551234567", call_consent: true };

  it("calls once, 30 s after an unseen alert, only with a phone number, consent and Twilio", async () => {
    start(TWILIO_ENV);
    const yes = await joinNurse(consenting);
    const noConsent = await joinNurse({ phone: "+15557654321", location: { lat: 40.3502, lng: -74.6602 } });
    const incident = await openSos();
    const alert = incident.alerts.find((a) => a.volunteer_id === yes.volunteer_id)!;
    expect(incident.alerts.some((a) => a.volunteer_id === noConsent.volunteer_id)).toBe(true);

    now += CALL_AFTER_MS - 1000;
    expect(rt.calls.tick()).toEqual([]);
    now += 1000;
    const placed = rt.calls.tick();
    await rt.calls.idle();
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ alert_id: alert.alert_id, kind: "alert", status: "placed", to: maskPhone("+15551234567") });
    expect(twilioCalls).toHaveLength(1);
    expect(twilioCalls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json");
    expect(twilioCalls[0]!.body.get("To")).toBe("+15551234567");
    const twiml = twilioCalls[0]!.body.get("Twiml")!;
    expect(twiml).toContain("This is Clara, a first-aid network demo.");
    expect(twiml).toContain("severe bleeding at Clinic tent");
    expect(twiml).toContain(`action="https://clara.test/api/twilio/gather?alert=${alert.alert_id}&amp;volunteer=${yes.volunteer_id}"`);
    expect(twiml.match(/<Gather /g)).toHaveLength(2);

    // One call per alert, ever.
    now += 60_000;
    expect(rt.calls.tick()).toEqual([]);
    expect(twilioCalls).toHaveLength(1);
  });

  it("doesn't call when the app showed the alert, and caps calls per volunteer per hour", async () => {
    start(TWILIO_ENV);
    const v = await joinNurse(consenting);
    await openSos();
    await getInbox(req("GET", "/x"), params({ id: v.volunteer_id })); // the app showed it: sent → shown
    now += CALL_AFTER_MS;
    expect(rt.calls.tick()).toEqual([]);

  });

  it("caps calls per volunteer per hour", async () => {
    const { createCallBook } = await import("../lib/calls");
    const book = createCallBook({ network: rt.network, twilio: null, baseUrl: "https://clara.test", maxPerHour: 1, log: () => {} });
    const v = await joinNurse(consenting);
    await openSos();
    now += CALL_AFTER_MS;
    expect(book.tick().find((e) => e.volunteer_id === v.volunteer_id)?.status).toBe("would_call");
    // A second emergency at the next box: alerted again (by the coordinator path), but the hourly cap holds the call.
    const second = await demoSos(req("POST", "/api/demo/sos?box=box-room-101&need=bleeding"));
    const secondId = ((await second.json()) as { incident: { incident_id: string } }).incident.incident_id;
    const r = rt.network.alertVolunteers(secondId, [v.volunteer_id]);
    expect(r.outcome === "alerted" && r.alerted.length).toBe(1);
    now += CALL_AFTER_MS;
    expect(book.tick().find((e) => e.volunteer_id === v.volunteer_id)?.status).toBe("capped");
  });

  it("without Twilio, only logs a masked would-call", async () => {
    const v = await joinNurse(consenting);
    await openSos();
    now += CALL_AFTER_MS;
    const out = rt.calls.tick();
    expect(rt.calls.configured).toBe(false);
    expect(out).toEqual([expect.objectContaining({ volunteer_id: v.volunteer_id, status: "would_call", to: maskPhone("+15551234567") })]);
    expect(twilioCalls).toHaveLength(0);
  });

  it("skips quiet hours", async () => {
    start(TWILIO_ENV);
    await joinNurse({ ...consenting, quiet_hours: { start: "18:30", end: "07:00", tz: "UTC" } });
    await openSos();
    now += CALL_AFTER_MS;
    expect(rt.calls.tick().map((e) => e.status)).toEqual(["quiet"]);
    expect(twilioCalls).toHaveLength(0);
    expect(inQuietHours({ start: "22:00", end: "07:00", tz: "UTC" }, new Date("2026-11-13T23:30:00Z"))).toBe(true);
    expect(inQuietHours({ start: "22:00", end: "07:00", tz: "UTC" }, new Date("2026-11-13T12:00:00Z"))).toBe(false);
  });
});

describe("Twilio gather", () => {
  const sign = (url: string, form: Record<string, string>) => twilioSignature("secret-token", url, form);
  const gatherReq = (query: string, form: Record<string, string>, signature?: string) =>
    new Request(`http://10.0.0.5:10000/api/twilio/gather?${query}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? sign(`https://clara.test/api/twilio/gather?${query}`, form) },
      body: new URLSearchParams(form).toString(),
    });

  it("validates the signature: a correct one passes, a wrong one or a tampered param fails", () => {
    const url = "https://clara.test/api/twilio/gather?alert=a1&volunteer=v1";
    const form = { Digits: "1", CallSid: "CA123", From: "+15551234567" };
    const good = twilioSignature("secret-token", url, form);
    expect(validTwilioSignature("secret-token", url, form, good)).toBe(true);
    expect(validTwilioSignature("secret-token", url, { ...form, Digits: "2" }, good)).toBe(false);
    expect(validTwilioSignature("other-token", url, form, good)).toBe(false);
    expect(validTwilioSignature("secret-token", url, form, null)).toBe(false);
    expect(validTwilioSignature("secret-token", url, form, "AAAA")).toBe(false);
  });

  it("maps 1 to coming and 2 to declined through network.respond, and rejects a bad signature", async () => {
    start(TWILIO_ENV);
    const v = await joinNurse({ phone: "+15551234567", call_consent: true });
    const incident = await openSos();
    const alert = incident.alerts.find((a) => a.volunteer_id === v.volunteer_id)!;
    const q = `alert=${alert.alert_id}&volunteer=${v.volunteer_id}`;

    const forged = await gather(gatherReq(q, { Digits: "1" }, "bm90IGEgc2lnbmF0dXJl"));
    expect(forged.status).toBe(403);
    expect(rt.network.incident(incident.incident_id)!.incident.alerts.find((a) => a.alert_id === alert.alert_id)!.state).toBe("sent");

    const yes = await gather(gatherReq(q, { Digits: "1", CallSid: "CA1" }));
    expect(yes.status).toBe(200);
    expect(yes.headers.get("content-type")).toContain("text/xml");
    expect(await yes.text()).toContain("Thank you. The box will tell them you&apos;re coming.");
    expect(rt.network.comingLine("box-clinic")).toMatch(/^Test Nurse is coming/);

    const no = await gather(gatherReq(q, { Digits: "2", CallSid: "CA1" }));
    expect(await no.text()).toContain("Okay, thank you.");
    expect(rt.network.incident(incident.incident_id)!.incident.alerts.find((a) => a.alert_id === alert.alert_id)!.state).toBe("declined");

    expect(await (await gather(gatherReq(q, { Digits: "7" }))).text()).toContain("isn&apos;t an answer");
  });

  it("refuses everything when Twilio isn't configured", async () => {
    expect((await gather(gatherReq("alert=a&volunteer=v", { Digits: "1" }))).status).toBe(403);
  });

  it("escapes the call's words", () => {
    expect(callTwiml("A <b> & c", "https://x/y?a=1&b=2")).toContain("A &lt;b&gt; &amp; c");
  });
});

describe("drivers at home: rides by push and phone", () => {
  /** A driver-only volunteer (no medical skills) at home ~1 km from the clinic box. */
  async function joinDriver(extra: Record<string, unknown> = {}) {
    const res = await signUp(
      req("POST", "/api/volunteers", {
        name: "Home Driver",
        skills: [],
        languages: ["en"],
        vehicle: "car",
        vehicle_seats: 3,
        location: { lat: 40.359, lng: -74.66 },
        channel: "app",
        carries_wheelchair: true,
        usual_availability: "Usually home evenings",
        ...extra,
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { volunteer: { volunteer_id: string; skills: string[]; carries_wheelchair?: boolean } }).volunteer;
  }

  it("signs up a driver with no medical skills as `driver` only, and refuses no way to help", async () => {
    const d = await joinDriver();
    expect(d.skills).toEqual(["driver"]);
    expect(d.carries_wheelchair).toBe(true);
    expect(rt.vehicles.get(d.volunteer_id)).toBe("car");
    const none = await signUp(req("POST", "/api/volunteers", { name: "Nobody", skills: [], languages: ["en"], vehicle: "none", vehicle_seats: 0, location: { lat: 40.35, lng: -74.66 }, channel: "app" }));
    expect(none.status).toBe(400);
    const badPhone = await signUp(req("POST", "/api/volunteers", { name: "X", skills: ["cpr"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.35, lng: -74.66 }, channel: "app", phone: "555-1234" }));
    expect(badPhone.status).toBe(400);
    const consentNoPhone = await signUp(req("POST", "/api/volunteers", { name: "X", skills: ["cpr"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.35, lng: -74.66 }, channel: "app", call_consent: true }));
    expect(consentNoPhone.status).toBe(400);
  });

  it("never gets first-aid alerts, but gets a RIDE NEEDED push when the dispatcher offers the ride", async () => {
    // Take the seeded drivers out so the home driver is the suggestion.
    for (const id of ["vol-tomas", "vol-priya", "vol-samir"]) rt.network.updateVolunteer(id, { available: false });
    const d = await joinDriver();
    rt.push.save(d.volunteer_id, sub(9));
    const incident = await openSos();
    now += 121_000;
    rt.network.tick();
    expect(rt.network.incident(incident.incident_id)!.incident.alerts.some((a) => a.volunteer_id === d.volunteer_id)).toBe(false);
    await rt.push.idle();
    expect(sent).toHaveLength(0);

    const ride = rt.rides.request(incident.incident_id, "1 adult, can sit up", 2)!;
    expect(ride.suggested?.driver_id).toBe(d.volunteer_id);
    expect(ride.hospital.name).toBe("District Hospital (fictional)");
    expect(ride.drivers_by_distance.map((x) => x.driver_id)).toContain(d.volunteer_id);
    expect(rt.rides.approve(ride.ride_id).ok).toBe(true);
    await rt.push.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.title).toBe("RIDE NEEDED");
    expect(sent[0]!.payload.body).toMatch(/^Clinic tent → District Hospital \(fictional\) · 2 seats · 1\.0 km from you\. Can you drive\?$/);
    expect(sent[0]!.payload.data).toMatchObject({ kind: "ride", ride_id: ride.ride_id, driver_id: d.volunteer_id });

    // Trip progress: only forward, only the winner.
    expect(rt.rides.answer(ride.ride_id, d.volunteer_id, "accept").outcome).toBe("accepted");
    expect(rt.rides.get(ride.ride_id)!.trip?.step).toBe("to_pickup");
    expect(rt.rides.progress(ride.ride_id, "vol-amina", "patient_in_car").outcome).toBe("not_winner");
    expect(rt.rides.progress(ride.ride_id, d.volunteer_id, "patient_in_car").outcome).toBe("updated");
    expect(rt.rides.progress(ride.ride_id, d.volunteer_id, "to_pickup").outcome).toBe("invalid");
    expect(rt.rides.progress(ride.ride_id, d.volunteer_id, "at_hospital").ride?.trip?.step).toBe("at_hospital");
  });

  it("calls a consenting driver 30 s after an unseen offer, extends the offer, and maps 1 to accept", async () => {
    start(TWILIO_ENV);
    for (const id of ["vol-tomas", "vol-priya", "vol-samir"]) rt.network.updateVolunteer(id, { available: false });
    const d = await joinDriver({ phone: "+15559876543", call_consent: true });
    const incident = await openSos();
    // Its first-aid alerts go to others; no call to the driver for those.
    const ride = rt.rides.request(incident.incident_id, null)!;
    rt.rides.approve(ride.ride_id, d.volunteer_id);
    const before = rt.rides.get(ride.ride_id)!.offers[0]!.expires_at;
    now += CALL_AFTER_MS;
    const out = rt.calls.tick().filter((e) => e.kind === "ride");
    await rt.calls.idle();
    expect(out).toEqual([expect.objectContaining({ alert_id: ride.ride_id, volunteer_id: d.volunteer_id, status: "placed" })]);
    const twiml = twilioCalls.find((c) => c.body.get("To") === "+15559876543")!.body.get("Twiml")!;
    expect(twiml).toContain("Press 1 if you can drive.");
    expect(twiml).toContain(`gather?ride=${ride.ride_id}&amp;driver=${d.volunteer_id}`);
    expect(Date.parse(rt.rides.get(ride.ride_id)!.offers[0]!.expires_at)).toBeGreaterThan(Date.parse(before));
    expect(rt.calls.tick().filter((e) => e.kind === "ride")).toEqual([]);

    const q = `ride=${ride.ride_id}&driver=${d.volunteer_id}`;
    const form = { Digits: "1", CallSid: "CA9" };
    const res = await gather(
      new Request(`http://internal/api/twilio/gather?${q}`, {
        method: "POST",
        headers: { "x-twilio-signature": twilioSignature("secret-token", `https://clara.test/api/twilio/gather?${q}`, form) },
        body: new URLSearchParams(form).toString(),
      }),
    );
    expect(await res.text()).toContain("you&apos;re driving");
    expect(rt.rides.get(ride.ride_id)!.winner?.driver_id).toBe(d.volunteer_id);
  });

  it("doesn't call a driver whose app already showed the offer", async () => {
    start(TWILIO_ENV);
    for (const id of ["vol-tomas", "vol-priya", "vol-samir"]) rt.network.updateVolunteer(id, { available: false });
    const d = await joinDriver({ phone: "+15559876543", call_consent: true });
    const incident = await openSos();
    const ride = rt.rides.request(incident.incident_id, null)!;
    rt.rides.approve(ride.ride_id, d.volunteer_id);
    await getInbox(req("GET", "/x"), params({ id: d.volunteer_id }));
    now += CALL_AFTER_MS;
    expect(rt.calls.tick().filter((e) => e.kind === "ride")).toEqual([]);
  });
});

describe("PATCH /api/volunteers/[id]", () => {
  it("edits the profile and validates each field", async () => {
    const v = await joinNurse();
    const p = params({ id: v.volunteer_id });
    const patch = async (body: unknown) => patchVolunteer(req("PATCH", "/x", body), p);

    const ok = await patch({ name: "Renamed", alert_radius_km: 3.5, phone: "+44 7700 900123", call_consent: true, quiet_hours: { start: "22:00", end: "06:30", tz: "Europe/London" } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { volunteer: Record<string, unknown> };
    expect(body.volunteer).toMatchObject({ name: "Renamed", alert_radius_km: 3.5, phone: "+447700900123", call_consent: true });

    expect((await patch({ phone: "12345" })).status).toBe(400);
    expect((await patch({ alert_radius_km: 0.2 })).status).toBe(400);
    expect((await patch({ alert_radius_km: 11 })).status).toBe(400);
    expect((await patch({ quiet_hours: { start: "25:00", end: "07:00", tz: "UTC" } })).status).toBe(400);
    expect((await patch({ volunteer_id: "vol-hijack" })).status).toBe(400);
    expect((await patch({ favourite_colour: "orange" })).status).toBe(400);
    expect((await patch({ vehicle: "spaceship" })).status).toBe(400);
    expect((await patch("not an object")).status).toBe(400);
    expect((await patchVolunteer(req("PATCH", "/x", { name: "x" }), params({ id: "vol-nobody" }))).status).toBe(404);

    // Clearing the phone also withdraws call consent.
    const cleared = (await (await patch({ phone: null, quiet_hours: null })).json()) as { volunteer: Record<string, unknown> };
    expect(cleared.volunteer.phone).toBeUndefined();
    expect(cleared.volunteer.call_consent).toBe(false);
    expect(cleared.volunteer.quiet_hours).toBeUndefined();
    expect((await patch({ call_consent: true })).status).toBe(400);

    // Becoming a driver too adds the driver skill; dropping first aid with no vehicle is refused.
    const driver = (await (await patch({ vehicle: "van", vehicle_seats: 6, carries_lying_down: true })).json()) as { volunteer: { skills: string[] }; vehicle: string };
    expect(driver.volunteer.skills).toEqual(["nurse", "driver"]);
    expect(driver.vehicle).toBe("van");
    expect((await patch({ vehicle: "none", skills: [] })).status).toBe(400);
    const noCar = (await (await patch({ vehicle: "none" })).json()) as { volunteer: { skills: string[]; vehicle_seats: number; carries_lying_down?: boolean } };
    expect(noCar.volunteer).toMatchObject({ skills: ["nurse"], vehicle_seats: 0 });
    expect(noCar.volunteer.carries_lying_down).toBeUndefined();

    const got = (await (await getVolunteer(req("GET", "/x"), p)).json()) as { volunteer: { name: string }; push_devices: number };
    expect(got.volunteer.name).toBe("Renamed");
    expect(got.push_devices).toBe(0);
  });
});

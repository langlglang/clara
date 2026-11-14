import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sequentialIds } from "@clara/network";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { POST as signUp } from "../app/api/volunteers/route";
import { PATCH as patchVolunteer } from "../app/api/volunteers/[id]/route";
import { POST as photonWebhook } from "../app/api/photon/webhook/route";
import { maskPhone } from "../lib/alertText";
import { parseReply, verifyWebhook, webhookSignature } from "../lib/photon";
import { createRuntime, setRuntime, type Runtime, type WebEnv } from "../lib/server";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let now = T0;
let rt: Runtime;
let calls: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }[];
let logs: string[];
const origLog = console.log;

const SECRET = `whsec_${Buffer.from("clara-test-signing-key-32-bytes!").toString("base64")}`;
const BASE_ENV: WebEnv = { CLARA_MODEL: "stub", VAPID_PUBLIC_KEY: "k", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "mailto:test@example.com" };
const PHOTON_ENV: WebEnv = { PHOTON_API_KEY: "pho_sk_test", PHOTON_PROJECT_ID: "pho_prj_test", PHOTON_WEBHOOK_SECRET: SECRET };
const PHONE = "+15551234567";
const SPACE = "pho_spc_space1";
const AGENT = "pho_usr_agent1";

/** Photon fake: GET /messages finds the volunteer's earlier message; POST /messages accepts. */
const fakeFetch = async (url: string, init: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
  calls.push({ url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : null });
  if ((init.method ?? "GET") === "GET")
    return Response.json({ items: [{ id: "pho_msg_old", platform: "imessage", status: "received", sentBy: { id: "pho_usr_v", handle: PHONE, kind: "human" }, receivedBy: { id: AGENT, kind: "agent" }, space: { id: SPACE } }] });
  return Response.json({ id: `pho_msg_${calls.length}` }, { status: 202 });
};

function start(extraEnv: WebEnv = {}) {
  rt?.stop();
  rt = createRuntime({ clock: () => new Date(now), ids: sequentialIds(), timers: false, env: { ...BASE_ENV, ...extraEnv }, pushSender: async () => ({ statusCode: 201 }), fetch: fakeFetch });
  setRuntime(rt);
}

beforeEach(() => {
  now = T0;
  calls = [];
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
});
afterEach(() => {
  console.log = origLog;
  setRuntime(null);
});

const req = (method: string, url: string, body?: unknown) => new Request(`http://test${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function joinNurse(extra: Record<string, unknown> = {}) {
  const res = await signUp(req("POST", "/api/volunteers", { name: "Text Nurse", skills: ["nurse"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.3501, lng: -74.6601 }, channel: "imessage", phone: PHONE, ...extra }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { volunteer: { volunteer_id: string } }).volunteer;
}
async function openSos() {
  const res = await demoSos(req("POST", "/api/demo/sos?box=box-clinic&need=bleeding"));
  return ((await res.json()) as { incident: { incident_id: string; alerts: { alert_id: string; volunteer_id: string }[] } }).incident;
}
const sends = () => calls.filter((c) => c.method === "POST");

function signed(event: unknown, opts: { secret?: string; ts?: number; id?: string } = {}) {
  const body = JSON.stringify(event);
  const id = opts.id ?? `evt_${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor((opts.ts ?? Date.now()) / 1000));
  return new Request("http://test/api/photon/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": webhookSignature(opts.secret ?? SECRET, id, ts, body) },
    body,
  });
}
const inbound = (text: string, phone = PHONE) => ({
  id: "evt_x",
  type: "message.received",
  data: { id: `pho_msg_in_${Math.random().toString(36).slice(2)}`, platform: "imessage", status: "received", content: { type: "text", format: "plain", text }, sentBy: { id: "pho_usr_v", handle: phone, kind: "human" }, receivedBy: { id: AGENT, kind: "agent" }, space: { id: SPACE } },
});

describe("Photon text alerts", () => {
  it("texts a volunteer who chose iMessage, with the exact payload shape", async () => {
    start(PHOTON_ENV);
    const v = await joinNurse();
    await openSos();
    await rt.texts.idle();
    const send = sends()[0]!;
    expect(send.url).toBe("https://api.photon.codes/v1/projects/pho_prj_test/messages");
    expect(send.headers.authorization).toBe("Bearer pho_sk_test");
    expect(send.headers["idempotency-key"]).toMatch(/^clara-/);
    expect(send.body).toEqual({ spaceId: SPACE, senderId: AGENT, content: { type: "text", format: "plain", text: expect.stringMatching(/^CLARA ALERT \(demo\): Severe bleeding at Clinic tent, \d+ m \(~\d+ min\)\. Reply 1 if you're coming, 2 if you can't\.$/) } });
    expect(rt.texts.recent()[0]).toMatchObject({ kind: "alert", volunteer_id: v.volunteer_id, status: "sent", to: maskPhone(PHONE) });
    expect(logs.join("\n")).not.toContain("pho_sk_test");
  });

  it("logs 'would message' with a masked number when Photon isn't configured, and skips app-only volunteers", async () => {
    start();
    await joinNurse();
    await joinNurse({ channel: "app", phone: "+15557654321", location: { lat: 40.3502, lng: -74.6602 } });
    await openSos();
    expect(calls).toHaveLength(0);
    const would = logs.filter((l) => l.includes("would message"));
    expect(would).toHaveLength(1);
    expect(would[0]).toContain(maskPhone(PHONE));
    expect(would[0]).not.toContain(PHONE);
  });

  it("respects quiet hours", async () => {
    start(PHOTON_ENV);
    await joinNurse({ quiet_hours: { start: "00:00", end: "23:59", tz: "UTC" } });
    await openSos();
    await rt.texts.idle();
    expect(sends()).toHaveLength(0);
    expect(rt.texts.recent()[0]).toMatchObject({ status: "quiet" });
  });

  it("won't choose texts without a phone, and removing the phone turns texts off", async () => {
    start();
    const v = await joinNurse();
    const p = { params: Promise.resolve({ id: v.volunteer_id }) };
    expect((await patchVolunteer(req("PATCH", "/x", { phone: null }), p)).status).toBe(200);
    expect(rt.network.store.getVolunteer(v.volunteer_id)!.channel).toBe("app");
    expect((await patchVolunteer(req("PATCH", "/x", { channel: "sms" }), p)).status).toBe(400);
  });
});

describe("Photon webhook", () => {
  it("verifies Standard Webhooks signatures", () => {
    const body = '{"a":1}';
    const ts = String(Math.floor(T0 / 1000));
    const sig = webhookSignature(SECRET, "evt_1", ts, body);
    expect(verifyWebhook(SECRET, { id: "evt_1", timestamp: ts, signature: `v1,bogus ${sig}` }, body, T0)).toBe(true);
    expect(verifyWebhook(SECRET, { id: "evt_1", timestamp: ts, signature: sig }, '{"a":2}', T0)).toBe(false);
    expect(verifyWebhook(SECRET, { id: "evt_1", timestamp: ts, signature: sig }, body, T0 + 6 * 60_000)).toBe(false);
    expect(verifyWebhook(SECRET, { id: "evt_1", timestamp: ts, signature: null }, body, T0)).toBe(false);
  });

  it("rejects a bad signature and refuses when no secret is set", async () => {
    start(PHOTON_ENV);
    expect((await photonWebhook(signed(inbound("1"), { secret: `whsec_${Buffer.from("wrong").toString("base64")}` }))).status).toBe(400);
    expect((await photonWebhook(signed(inbound("1"), { ts: Date.now() - 10 * 60_000 }))).status).toBe(400);
    start({ PHOTON_API_KEY: "pho_sk_test", PHOTON_PROJECT_ID: "pho_prj_test" });
    expect((await photonWebhook(signed(inbound("1")))).status).toBe(403);
  });

  it("maps 1 / yes to coming and replies; 2 / no to declined; unknown text gets instructions", async () => {
    expect(["1", "yes", "Coming!", "y"].map(parseReply)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(["2", "no", "No.", "can't"].map(parseReply)).toEqual(["no", "no", "no", "no"]);
    expect(parseReply("what?")).toBeNull();

    start(PHOTON_ENV);
    const v = await joinNurse();
    const incident = await openSos();
    const alert = incident.alerts.find((a) => a.volunteer_id === v.volunteer_id)!;
    await rt.texts.idle();
    calls = [];

    const help = await photonWebhook(signed(inbound("hello?")));
    expect(await help.json()).toEqual({ outcome: "help" });
    const yes = await photonWebhook(signed(inbound("yes")));
    expect(await yes.json()).toEqual({ outcome: "coming" });
    expect(rt.network.store.getIncident(incident.incident_id)!.incident.alerts.find((a) => a.alert_id === alert.alert_id)!.state).toBe("coming");
    await rt.texts.idle();
    expect(sends().map((c) => (c.body!.content as { text: string }).text)).toEqual([expect.stringContaining("Reply 1"), expect.stringContaining("you're coming")]);
    expect(sends()[1]!.body!.parentMessageId).toMatch(/^pho_msg_in_/);
    // Nothing else open now.
    expect(await (await photonWebhook(signed(inbound("2")))).json()).toEqual({ outcome: "nothing_open" });
    // Unknown phone.
    expect(await (await photonWebhook(signed(inbound("1", "+15550001111")))).json()).toEqual({ outcome: "unknown_sender" });
  });

  it("2 / no declines an alert, and a replayed webhook-id is ignored", async () => {
    start(PHOTON_ENV);
    const v = await joinNurse();
    const incident = await openSos();
    const r = signed(inbound("no"), { id: "evt_same" });
    expect(await (await photonWebhook(r)).json()).toEqual({ outcome: "declined" });
    expect(rt.network.store.getIncident(incident.incident_id)!.incident.alerts.find((a) => a.volunteer_id === v.volunteer_id)!.state).toBe("declined");
    expect((await photonWebhook(signed(inbound("no"), { id: "evt_same" }))).status).toBe(204);
  });

  it("texts a ride offer and maps 1 to accept the ride", async () => {
    start(PHOTON_ENV);
    for (const id of ["vol-tomas", "vol-priya", "vol-samir"]) rt.network.updateVolunteer(id, { available: false });
    const res = await signUp(req("POST", "/api/volunteers", { name: "Text Driver", skills: [], languages: ["en"], vehicle: "car", vehicle_seats: 3, location: { lat: 40.359, lng: -74.66 }, channel: "imessage", phone: PHONE }));
    const d = ((await res.json()) as { volunteer: { volunteer_id: string } }).volunteer;
    const incident = await openSos();
    const ride = rt.rides.request(incident.incident_id, null)!;
    rt.rides.approve(ride.ride_id, d.volunteer_id);
    await rt.texts.idle();
    const rideText = sends().map((c) => (c.body!.content as { text: string }).text).find((t) => t.startsWith("RIDE NEEDED"));
    expect(rideText).toMatch(/^RIDE NEEDED \(demo\): Clinic tent to .+\. Reply 1 to drive, 2 if not\.$/);
    expect(await (await photonWebhook(signed(inbound("1")))).json()).toEqual({ outcome: "driving" });
    expect(rt.rides.get(ride.ride_id)!.winner?.driver_id).toBe(d.volunteer_id);
  });
});

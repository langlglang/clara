import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_VERSION, VOICE_TURN_VERSION } from "@clara/contracts";
import { sequentialIds } from "@clara/network";
import { POST as postEvents } from "../app/api/boxes/[id]/events/route";
import { GET as boxStream } from "../app/api/boxes/[id]/stream/route";
import { POST as postTurn } from "../app/api/boxes/[id]/turns/route";
import { POST as restock } from "../app/api/boxes/[id]/restock/route";
import { POST as respond } from "../app/api/alerts/[id]/respond/route";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { GET as getIncident } from "../app/api/incidents/[id]/route";
import { GET as getReport } from "../app/api/report/[token]/route";
import { GET as getState } from "../app/api/state/route";
import { GET as getKitMap } from "../app/api/kit-map/route";
import { GET as getMaintainer } from "../app/api/maintainer/route";
import { POST as signUp } from "../app/api/volunteers/route";
import { GET as getInbox } from "../app/api/volunteers/[id]/inbox/route";
import { createRuntime, resolveGuidance, setRuntime, type Runtime } from "../lib/server";
import type { InboxResponse, IncidentDetail, StateSnapshot } from "../lib/views";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let now = T0;
let rt: Runtime;

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const post = (url: string, body?: unknown) =>
  new Request(`http://test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (url: string) => new Request(`http://test${url}`);

beforeEach(() => {
  now = T0;
  rt = createRuntime({ clock: () => new Date(now), ids: sequentialIds(), timers: false, env: { CLARA_MODEL: "stub" } });
  setRuntime(rt);
});
afterEach(() => setRuntime(null));

async function openSos(box = "box-clinic") {
  const res = await demoSos(post(`/api/demo/sos?box=${box}&need=bleeding`));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { incident: { incident_id: string; report_token: string; alerts: { alert_id: string; volunteer_id: string }[] } };
  return body.incident;
}

describe("box API", () => {
  it("takes an event batch, dedupes it, and rejects a bad one or another box's events", async () => {
    const session = randomUUID();
    const batch = {
      schema_version: EVENTS_VERSION,
      events: [
        { event_id: randomUUID(), box_id: "box-room-101", session_id: session, occurred_at: new Date(now).toISOString(), type: "box.opened" },
        { event_id: randomUUID(), box_id: "box-room-101", session_id: session, occurred_at: new Date(now + 1000).toISOString(), type: "sos.opened", need: "general", source: "touch" },
      ],
    };
    const first = await postEvents(post("/api/boxes/box-room-101/events", batch), params({ id: "box-room-101" }));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { accepted: number; opened: string[]; coming_line: string | null };
    expect(body.accepted).toBe(2);
    expect(body.opened).toHaveLength(1);
    expect(body.coming_line).toBeNull();

    const again = await postEvents(post("/api/boxes/box-room-101/events", batch), params({ id: "box-room-101" }));
    expect(((await again.json()) as { duplicates: number }).duplicates).toBe(2);

    expect((await postEvents(post("/api/boxes/box-clinic/events", batch), params({ id: "box-clinic" }))).status).toBe(400);
    expect((await postEvents(post("/api/boxes/box-clinic/events", { nope: 1 }), params({ id: "box-clinic" }))).status).toBe(400);
    expect((await postEvents(post("/api/boxes/box-x/events", batch), params({ id: "box-x" }))).status).toBe(404);
    const notJson = new Request("http://test/api/boxes/box-clinic/events", { method: "POST", body: "{" });
    expect((await postEvents(notJson, params({ id: "box-clinic" }))).status).toBe(400);
  });

  it("answers a text turn with the stub model and refuses a malformed one", async () => {
    const turn = {
      schema_version: VOICE_TURN_VERSION,
      client_turn_id: randomUUID(),
      session_id: randomUUID(),
      language: "en",
      input: { type: "text", text: "he is bleeding a lot" },
      state: { scenario_id: null, step_id: null, allowed_steps: [], questions: [], manifest: [], triage_available: false, recent_turns: [] },
    };
    const res = await postTurn(post("/api/boxes/box-clinic/turns", turn), params({ id: "box-clinic" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_turn_id: string; reply: string };
    expect(body.client_turn_id).toBe(turn.client_turn_id);
    expect(typeof body.reply).toBe("string");
    expect((await postTurn(post("/api/boxes/box-clinic/turns", { ...turn, schema_version: "x" }), params({ id: "box-clinic" }))).status).toBe(400);
    expect((await postTurn(post("/api/boxes/box-clinic/turns", { ...turn, schema_version: "voice-turn/0.1" }), params({ id: "box-clinic" }))).status).toBe(400);
    expect((await postTurn(post("/api/boxes/box-clinic/turns", { ...turn, schema_version: "voice-turn/0.5" }), params({ id: "box-clinic" }))).status).toBe(400);
  });

  it("returns canonical scenario text for an allowed selection", async () => {
    const turn = {
      schema_version: VOICE_TURN_VERSION,
      client_turn_id: randomUUID(),
      session_id: randomUUID(),
      language: "en",
      input: { type: "text", text: "There is bleeding" },
      state: { scenario_id: "severe_bleeding", step_id: null, allowed_steps: [{ step_id: "start", label: "Tell me what happened" }], questions: [], manifest: [], triage_available: false, recent_turns: [] },
    };
    const res = await postTurn(post("/api/boxes/box-clinic/turns", turn), params({ id: "box-clinic" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: { name: "select_step", step_id: "start" }, reply: "Tell me what happened and what you need help with.", speech: null });
    expect(resolveGuidance("unknown", "start")).toBeNull();
    expect(resolveGuidance("severe_bleeding", "unknown")).toBeNull();
  });

  it("streams the box's pushes as SSE", async () => {
    const controller = new AbortController();
    const res = await boxStream(new Request("http://test/api/boxes/box-clinic/stream", { signal: controller.signal }), params({ id: "box-clinic" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const incident = await openSos();
    let text = "";
    while (!text.includes("alert.update")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(incident.incident_id);
    controller.abort();
    await reader.cancel();
  });
});

describe("volunteers and alerts", () => {
  it("signs up a volunteer, who gets alerted, accepts, and arrives", async () => {
    const res = await signUp(
      post("/api/volunteers", {
        name: "Test Nurse",
        skills: ["nurse"],
        languages: ["en"],
        vehicle_seats: 0,
        location: { lat: 40.3501, lng: -74.6601 },
        channel: "app",
      }),
    );
    expect(res.status).toBe(201);
    const { volunteer } = (await res.json()) as { volunteer: { volunteer_id: string; available: boolean } };
    expect(volunteer.available).toBe(true);

    const incident = await openSos();
    const alert = incident.alerts.find((a) => a.volunteer_id === volunteer.volunteer_id);
    expect(alert).toBeDefined();

    const inboxRes = await getInbox(get(`/api/volunteers/${volunteer.volunteer_id}/inbox`), params({ id: volunteer.volunteer_id }));
    const inbox = (await inboxRes.json()) as InboxResponse;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.alert.state).toBe("shown");
    expect(inbox.items[0]!.box?.name).toBe("Clinic tent");
    expect(inbox.items[0]!.eta?.minutes).toBeGreaterThan(0);
    expect(inbox.items[0]!.handoff.some((l) => l.text.includes("bleeding"))).toBe(true);
    expect("report_token" in inbox.items[0]!.incident).toBe(false);

    // Someone else can't accept for them; a bad action is a 400.
    expect((await respond(post(`/api/alerts/${alert!.alert_id}/respond`, { volunteer_id: "vol-amina", action: "coming" }), params({ id: alert!.alert_id }))).status).toBe(403);
    expect((await respond(post(`/api/alerts/${alert!.alert_id}/respond`, { volunteer_id: volunteer.volunteer_id, action: "maybe" }), params({ id: alert!.alert_id }))).status).toBe(400);

    const coming = await respond(post(`/api/alerts/${alert!.alert_id}/respond`, { volunteer_id: volunteer.volunteer_id, action: "coming" }), params({ id: alert!.alert_id }));
    expect(coming.status).toBe(200);
    expect(((await coming.json()) as { coming_line: string }).coming_line).toMatch(/^Test Nurse is coming/);

    const arrived = await respond(post(`/api/alerts/${alert!.alert_id}/respond`, { volunteer_id: volunteer.volunteer_id, action: "arrived" }), params({ id: alert!.alert_id }));
    expect(((await arrived.json()) as { alert: { state: string } }).alert.state).toBe("arrived");

    const detail = (await (await getIncident(get(`/api/incidents/${incident.incident_id}`), params({ id: incident.incident_id }))).json()) as IncidentDetail;
    expect(detail.report?.responders[0]?.state).toBe("arrived");
    expect(detail.report?.notice).toMatch(/simulation/);
  });

  it("refuses an incomplete sign-up and an unknown volunteer's inbox", async () => {
    expect((await signUp(post("/api/volunteers", { name: "x" }))).status).toBe(400);
    expect((await getInbox(get("/api/volunteers/vol-nobody/inbox"), params({ id: "vol-nobody" }))).status).toBe(404);
  });
});

describe("dashboard, report, map and maintainer", () => {
  it("shows the incident in the state, and the scene report by token only", async () => {
    const incident = await openSos();
    const state = (await (await getState()).json()) as StateSnapshot;
    expect(state.boxes).toHaveLength(3);
    expect(state.incidents[0]!.incident.incident_id).toBe(incident.incident_id);
    expect(state.boxes.find((b) => b.box_id === "box-clinic")?.status).toBe("in_use");

    const report = await getReport(get(`/api/report/${incident.report_token}`), params({ token: incident.report_token }));
    expect(report.status).toBe(200);
    const { report: r } = (await report.json()) as { report: { timeline: { label: string }[] } };
    expect(r.timeline.length).toBeGreaterThan(0);
    expect((await getReport(get("/api/report/wrong-token-0000000"), params({ token: "wrong-token-0000000" }))).status).toBe(404);
  });

  it("serves the kit map and maintainer view, and restocks", async () => {
    const pins = (await (await getKitMap()).json()) as { pins: { status: string }[] };
    expect(pins.pins.every((p) => p.status === "ready")).toBe(true);
    const m = (await (await getMaintainer()).json()) as { rows: unknown[]; simulated_boxes: string[] };
    expect(m.rows).toHaveLength(3);
    expect(m.simulated_boxes).toContain("box-clinic");
    const res = await restock(post("/api/boxes/box-clinic/restock"), params({ id: "box-clinic" }));
    expect(res.status).toBe(200);
    expect((await restock(post("/api/boxes/box-x/restock"), params({ id: "box-x" }))).status).toBe(404);
    expect((await restock(post("/api/boxes/box-clinic/restock", { manifest: { gauze: -1 } }), params({ id: "box-clinic" }))).status).toBe(400);
  });

  it("demo SOS refuses an unknown box or need", async () => {
    expect((await demoSos(post("/api/demo/sos?box=box-x"))).status).toBe(404);
    expect((await demoSos(post("/api/demo/sos?box=box-clinic&need=fire"))).status).toBe(400);
  });
});

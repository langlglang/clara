import { afterEach, describe, expect, it } from "vitest";
import { createCoordinator } from "@clara/coordinator";
import { DEMO_BOXES, sequentialIds, type Ids } from "@clara/network";
import { POST as respond } from "../app/api/alerts/[id]/respond/route";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { GET as getState } from "../app/api/state/route";
import { POST as progress } from "../app/api/rides/[id]/progress/route";
import { POST as signUp } from "../app/api/volunteers/route";
import { GET as getInbox } from "../app/api/volunteers/[id]/inbox/route";
import { POST as savePush } from "../app/api/volunteers/[id]/push/route";
import { createPersistence, SQL, type PgLike } from "../lib/persist";
import type { PushSender, PushSubscriptionJson } from "../lib/push";
import { createRuntime, ensureRuntime, restoreRuntime, setRuntime, type Runtime, type RuntimeOptions } from "../lib/server";
import { parseSnapshot, SNAPSHOT_VERSION, type RuntimeState } from "../lib/snapshot";
import type { StateSnapshot } from "../lib/views";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let now = T0;
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://test${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const sub = (n: number): PushSubscriptionJson => ({ endpoint: `https://push.example.com/sub/${n}`, expirationTime: null, keys: { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", auth: "tBHItJI5svbpez7KI4CCXg" } });
const quiet = () => undefined;
const sender: PushSender = async () => ({ statusCode: 201 });

/** Ids that can't collide with the first runtime's sequential ones. */
const laterIds = (): Ids => {
  let n = 0;
  return { id: (p) => `${p}_r${++n}`, token: () => `rtoken${String(++n).padStart(16, "0")}` };
};

const options = (ids: Ids = sequentialIds()): RuntimeOptions => ({
  clock: () => new Date(now),
  ids,
  timers: false,
  // No VAPID env keys: the generated pair must be saved, or restored subscriptions would be useless.
  env: { CLARA_MODEL: "stub", CLARA_AMBULANCE_ETA_MIN: "35" },
  pushSender: sender,
  coordinator: ({ network, rides, careFor, ambulanceEtaMin }) => createCoordinator({ network, rides, careFor, ambulanceEtaMin, env: { CLARA_COORDINATOR: "rules" }, timers: false, debounceMs: 0, log: quiet }),
});

const snapshotOf = (rt: Runtime, generation = 1) => JSON.parse(JSON.stringify({ version: SNAPSHOT_VERSION, saved_at: new Date(now).toISOString(), generation, ...rt.exportState() })) as unknown;
const stateJson = async () => (await (await getState()).json()) as StateSnapshot;

afterEach(() => {
  setRuntime(null);
  now = T0;
});

/** A runtime mid-incident: a new volunteer with a phone, alerts in several states, a ride under way, a coordinator log. */
async function busyRuntime() {
  const rt = createRuntime(options());
  setRuntime(rt);
  const joined = await signUp(req("POST", "/api/volunteers", { name: "Test Nurse", skills: ["nurse"], languages: ["en"], vehicle_seats: 0, location: { lat: 40.3501, lng: -74.6601 }, channel: "app" }));
  expect(joined.status).toBe(201);
  const nurse = ((await joined.json()) as { volunteer: { volunteer_id: string } }).volunteer.volunteer_id;
  expect((await savePush(req("POST", "/x", { subscription: sub(1) }), params({ id: nurse }))).status).toBe(201);

  const sos = await demoSos(req("POST", "/api/demo/sos?box=box-clinic&need=bleeding"));
  expect(sos.status).toBe(201);
  const incident = ((await sos.json()) as { incident: { incident_id: string; alerts: { alert_id: string; volunteer_id: string }[] } }).incident;
  await rt.coordinator.idle();

  const nurseAlert = incident.alerts.find((a) => a.volunteer_id === nurse)!;
  expect(nurseAlert).toBeDefined();
  expect((await respond(req("POST", "/x", { volunteer_id: nurse, action: "coming" }), params({ id: nurseAlert.alert_id }))).status).toBe(200);
  const other = incident.alerts.find((a) => a.volunteer_id !== nurse)!;
  expect((await respond(req("POST", "/x", { volunteer_id: other.volunteer_id, action: "declined" }), params({ id: other.alert_id }))).status).toBe(200);
  await rt.coordinator.idle();

  // A ride with an accepted offer and a trip step (the coordinator may already have offered it).
  let ride = rt.rides.request(incident.incident_id, "1 adult")!;
  if (ride.state === "planning") ride = (rt.rides.approve(ride.ride_id) as { ok: true; ride: typeof ride }).ride;
  const offer = ride.offers.find((f) => f.state === "offered")!;
  expect(rt.rides.answer(ride.ride_id, offer.driver_id, "accept").outcome).toBe("accepted");
  expect(rt.rides.progress(ride.ride_id, offer.driver_id, "patient_in_car").outcome).toBe("updated");
  rt.messages.set(incident.incident_id, [{ incident_id: incident.incident_id, box_id: "box-clinic", from_id: nurse, from: "Test Nurse", text: "2 minutes away", at: new Date(now).toISOString() }]);
  return { rt, nurse, nurseAlert, incident, rideId: ride.ride_id, driver: offer.driver_id };
}

describe("snapshot round trip", () => {
  it("restores volunteers, push, alerts, rides, messages and the coordinator log; restored alert ids still answer", async () => {
    const { rt, nurse, nurseAlert, incident, rideId, driver } = await busyRuntime();
    const before = await stateJson();
    const inboxBefore = await (await getInbox(req("GET", "/x"), params({ id: nurse }))).json();
    const logBefore = rt.coordinator.getLog(incident.incident_id);
    expect(logBefore?.runs.length).toBeGreaterThan(0);
    const vapid = rt.push.vapid;
    expect(vapid.source).toBe("generated");
    const calls = rt.calls.recent();

    const raw = snapshotOf(rt);
    setRuntime(null);
    const { runtime: restored, restored: snap, rejected } = restoreRuntime(raw, options(laterIds()));
    expect(rejected).toBeNull();
    expect(snap?.saved_at).toBe(new Date(now).toISOString());
    setRuntime(restored);

    expect(await stateJson()).toEqual(before);
    expect(await (await getInbox(req("GET", "/x"), params({ id: nurse }))).json()).toEqual(inboxBefore);
    expect(restored.coordinator.getLog(incident.incident_id)).toEqual(logBefore);
    expect(restored.push.devices(nurse)).toBe(1);
    expect(restored.push.vapid).toMatchObject({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, source: "saved" });
    expect(restored.calls.recent()).toEqual(calls);
    expect(restored.messages.get(incident.incident_id)).toHaveLength(1);

    // The bug this fixes: "arrived" after a restart answers the restored alert instead of a 404.
    const arrived = await respond(req("POST", "/x", { volunteer_id: nurse, action: "arrived" }), params({ id: nurseAlert.alert_id }));
    expect(arrived.status).toBe(200);
    expect(((await arrived.json()) as { alert: { state: string } }).alert.state).toBe("arrived");
    const step = await progress(req("POST", "/x", { driver_id: driver, step: "at_hospital" }), params({ id: rideId }));
    expect(step.status).toBe(200);
  });

  it("leaves old heartbeats out but keeps sequence numbers moving forward", async () => {
    const rt = createRuntime({ ...options(), env: { CLARA_MODEL: "stub", CLARA_SIMULATED_BOXES: "box-clinic" } });
    for (let i = 0; i < 20; i++) {
      now += 30_000;
      rt.network.ingest({ schema_version: 1, events: [{ event_id: crypto.randomUUID(), box_id: "box-clinic", session_id: null, occurred_at: new Date(now).toISOString(), type: "box.heartbeat", battery_pct: 80, online_parts: [] }] });
    }
    const state = rt.exportState();
    expect(state.store.events.length).toBeLessThanOrEqual(5);
    const seq = rt.network.store.lastSeq();
    const { runtime: restored } = restoreRuntime(snapshotOf(rt), { ...options(laterIds()), env: { CLARA_MODEL: "stub", CLARA_SIMULATED_BOXES: "none" } });
    expect(restored.network.store.lastSeq()).toBe(seq);
    rt.stop();
    restored.stop();
  });
});

describe("bad snapshots", () => {
  it("starts fresh (demo seed) on an unknown version, invalid data or junk, without throwing", () => {
    const good = (() => {
      const rt = createRuntime(options());
      const s = snapshotOf(rt) as Record<string, unknown>;
      rt.stop();
      return s;
    })();
    const cases: [unknown, RegExp][] = [
      [{ ...good, version: 99 }, /unknown snapshot version 99/],
      [{ ...good, store: { ...(good.store as object), boxes: "nope" } }, /store/],
      [{ ...good, rides: [{ ride_id: 1 }] }, /rides\[0\]/],
      [{ ...good, coordinator: { slots: [{}] } }, /coordinator/],
      ["{ not json", /unreadable/],
      [42, /not a JSON object/],
    ];
    const error = console.error;
    console.error = quiet;
    try {
      for (const [raw, reason] of cases) {
        expect(parseSnapshot(raw).ok).toBe(false);
        const { runtime: rt, restored, rejected } = restoreRuntime(raw, options());
        expect(restored).toBeNull();
        expect(rejected).toMatch(reason);
        expect(rt.network.store.listBoxes().map((b) => b.box.box_id).sort()).toEqual(DEMO_BOXES.map((b) => b.box_id).sort());
        rt.stop();
      }
    } finally {
      console.error = error;
    }
    expect(parseSnapshot(good).ok).toBe(true);
  });
});

/** An in-memory clara_snapshot table that understands persist.ts's statements. */
class FakeDb implements PgLike {
  rows = new Map<string, { data: Record<string, unknown>; saved_at: Date }>();
  writes = 0;
  down = false;
  async query(text: string, params: unknown[] = []) {
    if (this.down) throw new Error("connect ECONNREFUSED");
    if (text === SQL.create) return { rows: [], rowCount: 0 };
    if (text === SQL.load) {
      const row = this.rows.get(params[0] as string);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (text === SQL.save) {
      const [id, data, generation] = params as [string, string, number];
      const current = this.rows.get(id);
      const stored = typeof current?.data.generation === "number" ? current.data.generation : 0;
      if (current && stored > generation) return { rows: [], rowCount: 0 };
      this.rows.set(id, { data: JSON.parse(data) as Record<string, unknown>, saved_at: new Date() });
      this.writes++;
      return { rows: [{ saved_at: new Date() }], rowCount: 1 };
    }
    if (text === SQL.keepRejected) {
      const [copyId, fromId] = params as [string, string];
      const row = this.rows.get(fromId);
      if (row && !this.rows.has(copyId)) this.rows.set(copyId, { ...row });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  }
}

describe("persist.ts with a fake database", () => {
  it("loads nothing on first boot, claims at attach, saves only on change, and a restart restores it", async () => {
    const db = new FakeDb();
    const p = createPersistence({ db, generation: 100, timers: false, log: quiet });
    expect(await p.load()).toEqual({ ok: true, raw: null });
    const { rt } = await busyRuntime();
    p.attach(rt, null);
    await p.saveNow();
    expect(db.writes).toBe(1);
    expect(p.status).toMatchObject({ enabled: true, saving: true, last_error: null, generation: 100 });
    expect(p.status.last_saved_at).not.toBeNull();
    expect(await p.saveNow()).toBe(true);
    expect(db.writes).toBe(1); // unchanged state: no write
    rt.network.updateVolunteer("vol-tomas", { available: false });
    await p.saveNow();
    expect(db.writes).toBe(2);
    const before = await stateJson();

    // "Restart": a new instance loads the row and serves the same state.
    setRuntime(null);
    const p2 = createPersistence({ db, generation: 200, timers: false, log: quiet });
    const loaded = await p2.load();
    const { runtime: restored, rejected } = restoreRuntime(loaded.raw, options(laterIds()));
    expect(rejected).toBeNull();
    setRuntime(restored);
    expect(await stateJson()).toEqual(before);
  });

  it("an older generation never overwrites a newer one, not even with its final save", async () => {
    const db = new FakeDb();
    const old = createPersistence({ db, generation: 100, timers: false, log: quiet });
    const oldRt = createRuntime(options());
    old.attach(oldRt, null);
    await old.saveNow();
    expect(db.rows.get("main")?.data.generation).toBe(100);

    // The new instance boots during the deploy: loads, then claims its generation at once.
    const fresh = createPersistence({ db, generation: 200, timers: false, log: quiet });
    const { runtime: newRt } = restoreRuntime((await fresh.load()).raw, options(laterIds()));
    fresh.attach(newRt, "x");
    await fresh.saveNow();
    expect(db.rows.get("main")?.data.generation).toBe(200);

    // The old instance keeps taking a request, then gets SIGTERM.
    oldRt.network.updateVolunteer("vol-tomas", { available: false });
    expect(await old.saveNow()).toBe(false);
    expect(old.status.saving).toBe(false);
    expect(old.status.last_error).toMatch(/newer server instance/);
    await old.flush();
    expect(db.rows.get("main")?.data.generation).toBe(200);
    const volunteers = (db.rows.get("main")?.data.store as { volunteers: { volunteer_id: string; available: boolean }[] }).volunteers;
    expect(volunteers.find((v) => v.volunteer_id === "vol-tomas")?.available).toBe(true);
    // The new instance keeps saving.
    newRt.network.updateVolunteer("vol-priya", { available: false });
    expect(await fresh.saveNow()).toBe(true);
    oldRt.stop();
    newRt.stop();
  });

  it("never saves after a failed load (the saved copy is kept), and rides out save failures", async () => {
    const db = new FakeDb();
    db.rows.set("main", { data: { version: 1, generation: 5, precious: true }, saved_at: new Date() });
    db.down = true;
    const p = createPersistence({ db, generation: 100, timers: false, log: quiet });
    const loaded = await p.load();
    expect(loaded.ok).toBe(false);
    expect(p.status.saving).toBe(false);
    expect(p.status.last_error).toMatch(/Couldn't read the saved state/);
    db.down = false;
    const rt = createRuntime(options());
    p.attach(rt, null);
    expect(await p.saveNow(true)).toBe(false);
    expect(db.rows.get("main")?.data.precious).toBe(true);
    rt.stop();

    // A healthy instance whose database drops mid-run: logs, reports, keeps going, recovers.
    const q = createPersistence({ db, generation: 300, timers: false, log: quiet });
    await q.load();
    const rt2 = createRuntime(options());
    q.attach(rt2, null);
    await q.saveNow();
    db.down = true;
    rt2.network.updateVolunteer("vol-tomas", { available: false });
    expect(await q.saveNow()).toBe(false);
    expect(q.status.last_error).toMatch(/Save failed/);
    expect(q.status.saving).toBe(true);
    db.down = false;
    expect(await q.saveNow()).toBe(true);
    expect(q.status.last_error).toBeNull();
    rt2.stop();
  });

  it("keeps a copy of an unreadable snapshot before starting fresh", async () => {
    const db = new FakeDb();
    db.rows.set("main", { data: { version: 7, generation: 1 }, saved_at: new Date() });
    const p = createPersistence({ db, generation: 100, timers: false, log: quiet });
    const loaded = await p.load();
    const error = console.error;
    console.error = quiet;
    const { runtime: rt, rejected } = restoreRuntime(loaded.raw, options());
    console.error = error;
    expect(rejected).toMatch(/unknown snapshot version 7/);
    await p.keepRejected(rejected!);
    expect([...db.rows.keys()].some((k) => k.startsWith("rejected-"))).toBe(true);
    p.attach(rt, null);
    await p.saveNow();
    expect((db.rows.get("main")?.data as unknown as RuntimeState & { version: number }).version).toBe(SNAPSHOT_VERSION);
    rt.stop();
  });
});

describe("ensureRuntime", () => {
  it("without DATABASE_URL is the in-memory runtime, ready at once", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const rt = createRuntime(options());
      setRuntime(rt);
      expect(await ensureRuntime()).toBe(rt);
      expect((await stateJson()).persistence).toMatchObject({ enabled: false, saving: false });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});

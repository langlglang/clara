/**
 * Scene simulator: plays a whole emergency against a running Clara server, so the response network can be
 * shown without hardware or a crowd of phones.
 *
 *   npx tsx scripts/simulate-scene.ts --server https://clara.living --box box-clinic
 *
 * It does two jobs:
 *   1. Acts as the box: posts the same events a real box sends (lid opens, steps, what the bystander said,
 *      tourniquet on, SOS countdown, SOS opened) through POST /api/boxes/{id}/events.
 *   2. Plays every volunteer the network alerts, like real people would: the first sees it and declines,
 *      the second accepts and walks over, the third never answers (so escalation and the coordinator kick in),
 *      and anyone alerted later sees it and the first of them also accepts.
 *   3. Plays the volunteer driver: when the response coordinator requests a ride to hospital itself (time to care:
 *      the simulated ambulance would be late and a driver is clearly faster), the first offered driver opens the
 *      offer, taps I CAN DRIVE, and steps through on the way → patient in car → arrived at hospital. If no ride
 *      appears (coordinator off, ambulance in time, no driver) the scene simply goes on without one.
 *
 * Optional: --cast adds six extra fictional volunteers within about a kilometre of the box first, and
 * --ask-nearby has the bystander ask nearby Clara boxes for their kits right after the SOS (never by default), and
 * --close sends box.closed at the end. Nothing here contacts a real person or emergency service.
 */
import { randomUUID } from "node:crypto";
import { EVENTS_VERSION } from "@clara/contracts";

type Alert = { alert_id: string; volunteer_id: string; volunteer_name: string; state: string; eta_minutes: number | null };
type Ride = { ride_id: string; state: string; offers: Array<{ driver_id: string; driver_name: string; state: string }>; winner: { driver_id: string; driver_name: string; pickup_minutes: number } | null; hospital: { name: string } };
type CoordinatorView = { log?: { notes?: Array<{ text: string }>; time_to_care?: { verdict: string; summary: string } | null; ride_request?: { reason: string; offered_to: string[] } | null } | null };
type Box = { box_id: string; name: string; location: { lat: number; lng: number } };

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SERVER = flag("server", "http://localhost:3000").replace(/\/+$/, "");
const BOX_ID = flag("box", "box-clinic");
const CAST = args.includes("--cast");
const CLOSE = args.includes("--close");
const ASK_NEARBY = args.includes("--ask-nearby");
const MAX_MINUTES = Number(flag("minutes", "4"));

const started = Date.now();
const stamp = () => {
  const s = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const say = (icon: string, text: string) => console.log(`${stamp()}  ${icon}  ${text}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${body?.error?.message ?? text.slice(0, 120)}`);
  return body as T;
}

// ---------- the box ----------
const sessionId = randomUUID();
async function boxEvents(events: Array<Record<string, unknown>>): Promise<void> {
  const now = Date.now();
  await api(`/api/boxes/${BOX_ID}/events`, {
    method: "POST",
    body: JSON.stringify({
      schema_version: EVENTS_VERSION,
      events: events.map((e, i) => ({
        event_id: randomUUID(),
        box_id: BOX_ID,
        session_id: sessionId,
        occurred_at: new Date(now + i).toISOString(),
        ...e,
      })),
    }),
  });
}
const step = (step_id: string, source = "voice") => ({ type: "step.shown", scenario_id: "severe_bleeding", step_id, source });
const done = (step_id: string, source = "touch") => ({ type: "step.done", scenario_id: "severe_bleeding", step_id, source });

// ---------- an optional cast of extra volunteers ----------
const CAST_LIST = [
  { name: "Hana", skills: ["stop_the_bleed", "first_aid"], seats: 0, dLat: 0.0012, dLng: 0.0009, languages: ["ar", "en"] },
  { name: "Omar", skills: ["first_aid", "driver"], seats: 3, dLat: -0.0021, dLng: 0.0015, languages: ["ar"] },
  { name: "Lena", skills: ["nurse"], seats: 0, dLat: 0.0035, dLng: -0.0022, languages: ["uk", "en"] },
  { name: "Sami", skills: ["cpr"], seats: 0, dLat: -0.0008, dLng: -0.0031, languages: ["fa", "en"] },
  { name: "Noor", skills: ["emt"], seats: 4, dLat: 0.0061, dLng: 0.0044, languages: ["ar", "en"] },
  { name: "Ivan", skills: ["first_aid"], seats: 0, dLat: -0.0049, dLng: 0.0057, languages: ["uk"] },
];
async function addCast(box: Box): Promise<void> {
  for (const c of CAST_LIST) {
    const location = { lat: box.location.lat + c.dLat, lng: box.location.lng + c.dLng };
    await api("/api/volunteers", {
      method: "POST",
      body: JSON.stringify({ name: c.name, skills: c.skills, languages: c.languages, vehicle_seats: c.seats, location, channel: "app" }),
    });
  }
  say("👥", `Added ${CAST_LIST.length} fictional volunteers within about 1 km of ${box.name}.`);
}

// ---------- how each alerted person behaves ----------
type Plan = { label: string; actions: Array<{ afterMs: number; action: "shown" | "coming" | "declined" | "arrived" }> };
const PLANS: Plan[] = [
  { label: "sees it, then declines", actions: [{ afterMs: 4_000, action: "shown" }, { afterMs: 11_000, action: "declined" }] },
  { label: "accepts and walks over", actions: [{ afterMs: 6_000, action: "shown" }, { afterMs: 14_000, action: "coming" }, { afterMs: 75_000, action: "arrived" }] },
  { label: "never answers", actions: [] },
];
const LATE_PLANS: Plan[] = [
  { label: "a doctor nearby: accepts", actions: [{ afterMs: 5_000, action: "shown" }, { afterMs: 12_000, action: "coming" }, { afterMs: 90_000, action: "arrived" }] },
  { label: "sees it, stays quiet", actions: [{ afterMs: 7_000, action: "shown" }] },
];

const planned = new Map<string, Plan>();
let lateIndex = 0;

function schedule(alert: Alert): void {
  if (planned.has(alert.alert_id)) return;
  const plan = planned.size < PLANS.length ? PLANS[planned.size]! : LATE_PLANS[Math.min(lateIndex++, LATE_PLANS.length - 1)]!;
  planned.set(alert.alert_id, plan);
  say("📟", `Alert reached ${alert.volunteer_name}'s phone (plays: ${plan.label}).`);
  for (const { afterMs, action } of plan.actions) {
    setTimeout(async () => {
      try {
        const r = await api<{ outcome: string; coming_line: string | null }>(`/api/alerts/${alert.alert_id}/respond`, {
          method: "POST",
          body: JSON.stringify({ volunteer_id: alert.volunteer_id, action }),
        });
        const verb = { shown: "saw the alert", coming: "tapped I'M COMING", declined: "declined (can't make it)", arrived: "arrived at the box" }[action];
        say(action === "declined" ? "✋" : action === "arrived" ? "✅" : action === "coming" ? "🏃" : "👀", `${alert.volunteer_name} ${verb}.`);
        if ((action === "coming" || action === "arrived") && r.coming_line) say("🔊", `Box says: "${r.coming_line}"`);
      } catch (error) {
        say("⚠️", `${alert.volunteer_name}: ${(error as Error).message}`);
      }
    }, afterMs);
  }
}

// ---------- the volunteer driver ----------
let rideHandled: string | null = null;
let rideDone = true;
function playDriver(ride: Ride): void {
  if (rideHandled === ride.ride_id || ride.state !== "offered") return;
  const first = ride.offers.find((f) => f.state === "offered");
  if (!first) return;
  rideHandled = ride.ride_id;
  rideDone = false;
  say("📲", `Ride offer reached ${ride.offers.filter((f) => f.state === "offered").map((f) => f.driver_name).join(" and ")} (first to accept drives; ${first.driver_name} plays: accepts).`);
  const steps: Array<{ afterMs: number; run: () => Promise<void> }> = [
    {
      afterMs: 3_000,
      run: async () => {
        // Opening the app shows the offer (marks it seen, so no phone call is needed).
        await api(`/api/volunteers/${first.driver_id}/inbox`);
        say("👀", `${first.driver_name} opened the ride offer.`);
      },
    },
    {
      afterMs: 7_000,
      run: async () => {
        const r = await api<{ outcome: string; ride?: Ride }>(`/api/rides/${ride.ride_id}/answer`, { method: "POST", body: JSON.stringify({ driver_id: first.driver_id, action: "accept" }) });
        say("🚗", `${first.driver_name} tapped I CAN DRIVE (${r.outcome}); on the way to pickup, about ${Math.max(1, r.ride?.winner?.pickup_minutes ?? 1)} min.`);
      },
    },
    { afterMs: 20_000, run: async () => void (await progress(ride, first, "patient_in_car", "Patient in the car.")) },
    { afterMs: 35_000, run: async () => void (await progress(ride, first, "at_hospital", `Arrived at ${ride.hospital.name}.`)) },
  ];
  for (const s of steps)
    setTimeout(async () => {
      try {
        await s.run();
      } catch (error) {
        say("⚠️", `${first.driver_name}: ${(error as Error).message}`);
        rideDone = true;
      }
    }, s.afterMs);
}
async function progress(ride: Ride, driver: { driver_id: string; driver_name: string }, step: string, text: string): Promise<void> {
  await api(`/api/rides/${ride.ride_id}/progress`, { method: "POST", body: JSON.stringify({ driver_id: driver.driver_id, step }) });
  say(step === "at_hospital" ? "🏥" : "🧍", `${driver.driver_name}: ${text}`);
  if (step === "at_hospital") rideDone = true;
}

// ---------- run ----------
async function main(): Promise<void> {
  const state = await api<{ boxes: Box[] }>("/api/state");
  const box = state.boxes.find((b) => b.box_id === BOX_ID);
  if (!box) throw new Error(`No box "${BOX_ID}". Boxes: ${state.boxes.map((b) => b.box_id).join(", ")}`);
  console.log(`\nClara scene simulator → ${SERVER}  (box: ${box.name})`);
  console.log(`Watch it live: ${SERVER}/dashboard   ·   Fictional scene; no real person or emergency service is contacted.\n`);
  if (CAST) await addCast(box);

  say("📦", `Lid opens at ${box.name}. Clara: "Tell me what happened."`);
  await boxEvents([{ type: "box.opened" }, { type: "scenario.started", scenario_id: "severe_bleeding", source: "touch" }, step("start", "touch")]);
  await sleep(3_000);
  say("🗣️", `Bystander: "My friend cut his leg on metal, there's a lot of blood."`);
  await boxEvents([{ type: "report.heard", text: "My friend cut his leg on metal, there's a lot of blood." }, done("start", "voice"), step("safety")]);
  await sleep(2_500);
  say("🧤", "Gloves compartment lights up; bystander puts them on.");
  await boxEvents([done("safety"), step("get_help")]);
  say("⏱️", "SOS countdown: 5 seconds (tap to cancel)…");
  await boxEvents([{ type: "sos.countdown", seconds: 5, source: "system" }]);
  await sleep(5_000);
  await boxEvents([{ type: "sos.opened", need: "bleeding", source: "system" }, done("get_help", "system"), step("find_wound")]);
  if (ASK_NEARBY) {
    await boxEvents([{ type: "nearby.requested", source: "voice" }]);
    say("📦", "The bystander asked nearby Clara boxes to bring their kits (boxes within 1 km now show it).");
  }
  say("🚨", "SOS opened: simulated 911 screen on the box; the network alerts nearby volunteers.");

  let tourniquetSent = false;
  let closedAt: number | null = null;
  let seenNotes = 0;
  let seenCare = "";
  let seenRequest = false;
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const now = await api<{ boxes: Array<Box & { open_incident_id: string | null }> }>("/api/state");
    const incidentId = now.boxes.find((b) => b.box_id === BOX_ID)?.open_incident_id;
    if (incidentId) {
      const detail = await api<{ incident?: { alerts: Alert[] }; alerts?: Alert[]; ride?: Ride | null }>(`/api/incidents/${incidentId}`);
      const alerts = detail.incident?.alerts ?? detail.alerts ?? [];
      alerts.forEach(schedule);
      if (!tourniquetSent && Date.now() - started > 20_000) {
        tourniquetSent = true;
        say("🩸", "Tourniquet compartment lights; bystander applies it high on the thigh and twists until the bleeding stops.");
        await boxEvents([done("find_wound"), step("tourniquet"), done("tourniquet"), step("tighten"), { type: "timer.started", timer: "tourniquet", step_id: "tighten" }]);
      }
      try {
        const view = await api<CoordinatorView>(`/api/incidents/${incidentId}/coordinator`);
        const care = view.log?.time_to_care;
        if (care && care.verdict !== seenCare) {
          seenCare = care.verdict;
          say("⏳", `Time to care: ${care.summary}`);
        }
        const request = view.log?.ride_request;
        if (request && !seenRequest) {
          seenRequest = true;
          say("🚕", `Ride requested by coordinator: ${request.reason}`);
        }
        const notes = view.log?.notes ?? [];
        for (const n of notes.slice(seenNotes)) say("🧠", `Coordinator: ${n.text}`);
        seenNotes = notes.length;
      } catch {
        /* coordinator off or not deployed */
      }
      if (detail.ride) playDriver(detail.ride);
      const arrived = alerts.some((a) => a.state === "arrived");
      if (arrived && closedAt === null) closedAt = Date.now();
    }
    if (closedAt !== null && rideDone && Date.now() - closedAt > 5_000) break;
    await sleep(3_000);
  }

  if (CLOSE) {
    await boxEvents([{ type: "box.closed" }]);
    say("📦", "Lid closed; the incident ends.");
  } else {
    say("ℹ️", `Scene left open so you can explore it on ${SERVER}/dashboard (rerun with --close to end it).`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nSimulation failed: ${(error as Error).message}`);
  process.exit(1);
});

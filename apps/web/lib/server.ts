import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, type BoxEvent } from "@clara/contracts";
import { createClaraAgent, type ClaraAgent, type ClaraAgentEnv } from "@clara/agent";
import { DEFAULT_CARE, createCoordinator, type CareThreshold, type Coordinator, type CoordinatorChange, type CoordinatorEnv, type Need, type RidesAdapter } from "@clara/coordinator";
import { DEMO_BOXES, createNetwork, randomIds, type MaintainerAlert, type Network, type NetworkOptions, type ReportOptions } from "@clara/network";
import { createRideBook, type Ride, type RideBook, type RideChange, type VehicleKind } from "./rides";
import { createCallBook, type CallBook } from "./calls";
import { ridePushListener, wireAlertPushes } from "./notify";
import { createPushBook, resolveVapid, type PushBook, type PushSender, type VapidEnv } from "./push";
import { publicBaseUrl, twilioConfig, type FetchLike, type TwilioConfig, type TwilioEnv } from "./twilio";
import bleeding from "../../../content/scenarios/severe-bleeding.json";

/**
 * One response network and one Clara agent per server process. Kept on globalThis so `next dev` hot reloads
 * (and Next's separate route bundles) all share the same in-memory network. Seeded with the fictional demo
 * site on first use; a 1 s interval drives escalation, expiry and offline detection (the network starts no
 * timers itself).
 */

export const TICK_MS = 1_000;
export const SIM_HEARTBEAT_MS = 30_000;
const MAX_MAINTAINER_ALERTS = 50;

/** A message a volunteer sent to the box (read aloud there). */
export interface BoxMessage {
  incident_id: string;
  box_id: string;
  from_id: string;
  from: string;
  text: string;
  at: string;
}

/** App-level changes the network facade doesn't publish itself (rides, messages, profile details). */
export type AppChange = RideChange | CoordinatorChange | { kind: "message"; message: BoxMessage } | { kind: "profile"; volunteer_id: string };

export interface Runtime {
  network: Network;
  agent: ClaraAgent;
  rides: RideBook;
  /** The response coordinator (deep agent, rules, or off): plans the human response per incident. */
  coordinator: Coordinator;
  /** Vehicle kind per volunteer (the contract only has seat counts). */
  vehicles: Map<string, VehicleKind>;
  /** Messages to boxes, per incident, oldest first. */
  messages: Map<string, BoxMessage[]>;
  /** Minutes until an ambulance can reach the site, from CLARA_AMBULANCE_ETA_MIN; null when not set. */
  ambulanceEtaMin: number | null;
  /** Recent maintainer alerts (low supplies, offline), newest first. */
  maintainerAlerts: MaintainerAlert[];
  /** Demo boxes that get simulated heartbeats. */
  simulatedBoxes: string[];
  /** Labels the scene report uses for step and scenario ids (from content/). */
  reportOptions: ReportOptions;
  /** Web push subscriptions per volunteer and the VAPID keys (both in memory). */
  push: PushBook;
  /** The phone-call fallback (Twilio, or "would call" logs without it). */
  calls: CallBook;
  /** Twilio settings (null: calls only log) and the public origin Twilio calls back on. */
  twilio: TwilioConfig | null;
  publicBaseUrl: string;
  /** App-level live changes (box stream and /api/stream listen here as well as on the network). */
  subscribe(listener: (change: AppChange) => void): () => void;
  emit(change: AppChange): void;
  stop(): void;
}

/** Vehicles for the seeded drivers (fictional). */
const DEMO_VEHICLES: Record<string, VehicleKind> = { "vol-tomas": "van", "vol-priya": "car", "vol-samir": "car" };

/** The server's environment: the agent's keys plus web push (VAPID_*) and Twilio (TWILIO_*, PUBLIC_BASE_URL). */
export type WebEnv = ClaraAgentEnv & VapidEnv & TwilioEnv;

export interface RuntimeOptions extends NetworkOptions {
  env?: WebEnv;
  /** Replace web-push's sender (tests). */
  pushSender?: PushSender;
  /** Replace fetch for Twilio (tests). */
  fetch?: FetchLike;
  agent?: ClaraAgent;
  /** Start the tick loop (default true). Tests turn it off and call tick themselves. */
  timers?: boolean;
  /** Replace the coordinator (tests). */
  coordinator?: (deps: { network: Network; rides: RidesAdapter; careFor: (need: Need) => CareThreshold; ambulanceEtaMin: number | null }) => Coordinator;
}

const stepLabels: Record<string, string> = Object.fromEntries(bleeding.steps.map((s: { step_id: string; label: string }) => [s.step_id, s.label]));
const guidanceText = new Map<string, string>(bleeding.steps.map((s) => [s.step_id, s.text] as const));
/** Resolve guidance from the server's versioned demo bundle, never from model or device text. */
export function resolveGuidance(scenarioId: string, stepId: string): string | null {
  return scenarioId === bleeding.scenario_id ? guidanceText.get(stepId) ?? null : null;
}
export const REPORT_OPTIONS: ReportOptions = {
  timeZone: "America/New_York",
  stepLabels,
  scenarioLabels: { [bleeding.scenario_id]: bleeding.title },
};

/** Demo time-to-care thresholds per need: the scenario's care block, else DEFAULT_CARE. Fictional, not medical guidance. */
const SCENARIO_CARE: Partial<Record<Need, CareThreshold>> = { bleeding: (bleeding as { care?: CareThreshold }).care };
export const careFor = (need: Need): CareThreshold => SCENARIO_CARE[need] ?? DEFAULT_CARE[need] ?? DEFAULT_CARE.general;

function simulatedBoxIds(env: ClaraAgentEnv): string[] {
  const raw = env.CLARA_SIMULATED_BOXES;
  if (raw === undefined) return DEMO_BOXES.map((b) => b.box_id);
  if (raw.trim().toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fixed, plainly fake battery levels for simulated boxes, so the maintainer page has something to show. */
const SIM_BATTERY: Record<string, number> = { "box-clinic": 86, "box-room-101": 64, "box-water-point": 23 };

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env: WebEnv = { CLARA_TURN_BUDGET_MS: "6500", ...(options.env ?? (process.env as WebEnv)) };
  const network = createNetwork(options);
  network.seedDemo();
  const agent = options.agent ?? createClaraAgent(env, { guidance: resolveGuidance, log: (line) => console.log(line) });
  const maintainerAlerts: MaintainerAlert[] = [];
  network.subscribe((change) => {
    if (change.kind !== "maintainer") return;
    maintainerAlerts.unshift(change.alert);
    maintainerAlerts.length = Math.min(maintainerAlerts.length, MAX_MAINTAINER_ALERTS);
  });

  const listeners = new Set<(change: AppChange) => void>();
  const emit = (change: AppChange) => {
    for (const l of [...listeners]) {
      try {
        l(change);
      } catch {
        // A broken listener never breaks the others.
      }
    }
  };
  const vehicles = new Map<string, VehicleKind>(Object.entries(DEMO_VEHICLES));
  const rides = createRideBook({
    network,
    ids: options.ids ?? randomIds,
    vehicleOf: (id) => vehicles.get(id) ?? ((network.store.getVolunteer(id)?.vehicle_seats ?? 0) > 0 ? "car" : "none"),
    emit,
  });
  const ambulance = Number(env.CLARA_AMBULANCE_ETA_MIN);
  const ambulanceEtaMin = env.CLARA_AMBULANCE_ETA_MIN && Number.isFinite(ambulance) && ambulance > 0 ? Math.round(ambulance) : null;
  // The coordinator proposes rides for the dispatcher to approve. Its one way to send offers itself is requestNow,
  // which its request_ride tool calls only behind the code-checked time-to-care bar (packages/coordinator/src/tools.ts).
  const ridesAdapter: RidesAdapter = {
    forIncident: (id) => rides.forIncident(id),
    request: (id, note) => rides.request(id, note),
    preview: (id) => rides.preview(id),
    requestNow: (id, note) => rides.requestNow(id, note),
  };
  const coordinator = options.coordinator
    ? options.coordinator({ network, rides: ridesAdapter, careFor, ambulanceEtaMin })
    : createCoordinator({ network, rides: ridesAdapter, careFor, ambulanceEtaMin, env: env as CoordinatorEnv, timers: options.timers !== false, log: (line) => console.log(line) });
  coordinator.subscribe((change) => emit(change));

  const push = createPushBook({ vapid: resolveVapid(env), ...(options.pushSender ? { sender: options.pushSender } : {}) });
  wireAlertPushes(network, push);
  const onRide = ridePushListener(network, push);
  listeners.add((change) => onRide(change as { kind: string; ride?: Ride }));
  const twilio = twilioConfig(env);
  const calls = createCallBook({ network, rides, twilio, baseUrl: publicBaseUrl(env), ...(options.fetch ? { fetch: options.fetch } : {}) });

  const simulatedBoxes = simulatedBoxIds(env).filter((id) => network.store.getBox(id));
  const heartbeat = () => {
    if (simulatedBoxes.length === 0) return;
    const at = network.clock().toISOString();
    const events: BoxEvent[] = simulatedBoxes.map((box_id) => ({
      event_id: randomUUID(),
      box_id,
      session_id: null,
      occurred_at: at,
      type: "box.heartbeat",
      battery_pct: SIM_BATTERY[box_id] ?? 75,
      online_parts: ["simulated"],
    }));
    network.ingest({ schema_version: EVENTS_VERSION, events });
  };
  heartbeat();

  const timers: NodeJS.Timeout[] = [];
  if (options.timers !== false) {
    const tick = setInterval(() => {
      try {
        network.tick();
        rides.tick();
        calls.tick();
      } catch (error) {
        console.error("[network] tick failed:", error);
      }
    }, TICK_MS);
    const beat = setInterval(heartbeat, SIM_HEARTBEAT_MS);
    tick.unref?.();
    beat.unref?.();
    timers.push(tick, beat);
  }
  console.log(`[clara] network seeded (${network.store.listBoxes().length} boxes); agent ${agent.describe}; coordinator ${coordinator.describe}; simulated boxes: ${simulatedBoxes.join(", ") || "none"}; push VAPID ${push.vapid.source}; calls ${twilio ? "Twilio" : "not configured (logs only)"}`);

  return {
    network,
    agent,
    rides,
    coordinator,
    vehicles,
    push,
    calls,
    twilio,
    publicBaseUrl: publicBaseUrl(env),
    messages: new Map(),
    ambulanceEtaMin,
    maintainerAlerts,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit,
    simulatedBoxes,
    reportOptions: REPORT_OPTIONS,
    stop: () => {
      timers.forEach(clearInterval);
      coordinator.stop();
    },
  };
}

const KEY = Symbol.for("clara.web.runtime");
type Holder = { [KEY]?: Runtime };

/** The process's runtime, created on first use. */
export function runtime(): Runtime {
  const g = globalThis as Holder;
  g[KEY] ??= createRuntime();
  return g[KEY];
}

/** Tests: swap in a runtime (or clear it with null). */
export function setRuntime(next: Runtime | null): void {
  const g = globalThis as Holder;
  g[KEY]?.stop();
  if (next) g[KEY] = next;
  else delete g[KEY];
}

import { randomUUID } from "node:crypto";
import { EVENTS_VERSION, ScenarioTranslationSchema, type BoxEvent } from "@clara/contracts";
import { createClaraAgent, createClaudeModel, type ClaraAgent, type ClaraAgentEnv } from "@clara/agent";
import { answerDispatcher, sceneFacts } from "./dispatchTalk";
import { DEFAULT_CARE, createCoordinator, type CareThreshold, type Coordinator, type CoordinatorChange, type CoordinatorEnv, type Need, type RidesAdapter } from "@clara/coordinator";
import { DEMO_BOXES, createNetwork, randomIds, type MaintainerAlert, type Network, type NetworkOptions, type ReportOptions } from "@clara/network";
import { createRideBook, type Ride, type RideBook, type RideChange, type VehicleKind } from "./rides";
import { createCallBook, type CallBook } from "./calls";
import { createDemo911, type Demo911 } from "./demo911";
import { createSpeech, type ClaraSpeech } from "./speech";
import { createAutoSupply } from "./autoSupply";
import { ridePushListener, wireAlertPushes } from "./notify";
import { createPushBook, resolveVapid, type PushBook, type PushSender, type VapidEnv } from "./push";
import { createTextBook, photonConfig, wireTexts, type PhotonConfig, type PhotonEnv, type TextBook } from "./photon";
import { publicBaseUrl, twilioConfig, type FetchLike, type TwilioConfig, type TwilioEnv } from "./twilio";
import { createPersistence, type Persistence } from "./persist";
import { createEmergencyWorker, type EmergencyWorker } from "./emergency";
import { createCoreSessionBook, type CoreSessionBook } from "./core-session";
import { PERSISTENCE_OFF, parseSnapshot, type PersistenceStatus, type RuntimeState, type Snapshot } from "./snapshot";
import bleeding from "../../../content/scenarios/severe-bleeding.json";
import minorCut from "../../../content/scenarios/minor-cut.json";
import armGash from "../../../content/scenarios/arm-gash.json";
import notBreathing from "../../../content/scenarios/not-breathing.json";
import bleedingEs from "../../../content/scenarios/es/severe-bleeding.json";
import minorCutEs from "../../../content/scenarios/es/minor-cut.json";
import notBreathingEs from "../../../content/scenarios/es/not-breathing.json";

/**
 * One response network and one Clara agent per server process. Kept on globalThis so `next dev` hot reloads
 * (and Next's separate route bundles) all share the same in-memory network. Seeded with the fictional demo
 * site on first use; a 1 s interval drives escalation, expiry and offline detection (the network starts no
 * timers itself). With DATABASE_URL the state is restored from (and saved to) a Postgres snapshot: route
 * handlers get the runtime through `ensureRuntime()`, which waits for that load (lib/persist.ts).
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
  /** Independent simulated-911 fact collector; never places a real call. */
  emergency: EmergencyWorker;
  core: CoreSessionBook;
  cameraEnabled: boolean;
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
  /** Demo "911": rings the team's demo dispatcher phone (CLARA_DEMO_911_NUMBER) when an SOS opens. */
  demo911: Demo911;
  /** Clara's Cartesia voice for everything the server says (box lines, the call page, the Twilio call). */
  speech: ClaraSpeech;
  publicBaseUrl: string;
  /** Text alerts over Photon (iMessage/WhatsApp/SMS), or "would message" logs without it. */
  texts: TextBook;
  photon: PhotonConfig | null;
  /** App-level live changes (box stream and /api/stream listen here as well as on the network). */
  subscribe(listener: (change: AppChange) => void): () => void;
  emit(change: AppChange): void;
  /** Everything above that changes at run time, as plain JSON (persistence snapshots). */
  exportState(): RuntimeState;
  /** Persistence status for /api/state (filled in by lib/persist.ts; PERSISTENCE_OFF without a database). */
  persistence: PersistenceStatus;
  stop(): void;
}

/** Vehicles for the seeded drivers (fictional). */
const DEMO_VEHICLES: Record<string, VehicleKind> = { "vol-tomas": "van", "vol-priya": "car", "vol-samir": "car" };

/** The server's environment: the agent's keys plus web push (VAPID_*) and Twilio (TWILIO_*, PUBLIC_BASE_URL). */
export type WebEnv = ClaraAgentEnv & VapidEnv & TwilioEnv & PhotonEnv & { CLARA_BOX_TOKEN?: string; CLARA_DEMO_911_NUMBER?: string };

export interface RuntimeOptions extends NetworkOptions {
  env?: WebEnv;
  /** Replace web-push's sender (tests). */
  pushSender?: PushSender;
  /** Replace fetch for Twilio (tests). */
  fetch?: FetchLike;
  agent?: ClaraAgent;
  /** Start the tick loop (default true). Tests turn it off and call tick themselves. */
  timers?: boolean;
  /** Start from this (already checked) snapshot instead of the demo seed. See restoreRuntime for unchecked data. */
  snapshot?: Snapshot;
  /** Replace the coordinator (tests). */
  coordinator?: (deps: { network: Network; rides: RidesAdapter; careFor: (need: Need) => CareThreshold; ambulanceEtaMin: number | null }) => Coordinator;
}

const scenarios = [bleeding, minorCut, armGash, notBreathing];
const stepLabels: Record<string, string> = Object.fromEntries(scenarios.flatMap((scenario) => scenario.steps.map((s: { step_id: string; label: string }) => [s.step_id, s.label])));
const guidanceText = new Map(scenarios.map((scenario) => [scenario.scenario_id, new Map(scenario.steps.map((s) => [s.step_id, s.text] as const))] as const));
/** Scenario words in other languages (content/scenarios/<language>/), checked against the schema at startup. */
const translations = [bleedingEs, minorCutEs, notBreathingEs].map((t) => ScenarioTranslationSchema.parse(t));
/**
 * Resolve guidance from the server's versioned demo bundle, never from model or device text. Another language uses
 * its translation's words for the same step (the box checks the same text); a step it lacks stays English.
 */
export function resolveGuidance(scenarioId: string, stepId: string, language = "en"): string | null {
  const lang = language.toLowerCase().split("-")[0]!;
  const translated = lang === "en" ? undefined : translations.find((t) => t.language === lang && t.scenario_id === scenarioId)?.steps[stepId]?.text;
  return translated ?? guidanceText.get(scenarioId)?.get(stepId) ?? null;
}
export const REPORT_OPTIONS: ReportOptions = {
  timeZone: "America/New_York",
  stepLabels,
  scenarioLabels: Object.fromEntries(scenarios.map((scenario) => [scenario.scenario_id, scenario.title])),
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
  const snap = options.snapshot ?? null;
  const network = createNetwork({ publicBaseUrl: publicBaseUrl(env), ...options });
  // The demo seed only for a fresh start: a restored snapshot already holds the boxes and volunteers.
  if (snap) network.store.importState(snap.store);
  else network.seedDemo();
  const agent = options.agent ?? createClaraAgent(env, { guidance: resolveGuidance, log: (line) => console.log(line) });
  const maintainerAlerts: MaintainerAlert[] = snap ? snap.maintainer_alerts.slice(0, MAX_MAINTAINER_ALERTS) : [];
  const messages = new Map<string, BoxMessage[]>(snap ? Object.entries(snap.messages) : []);
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
  const vehicles = new Map<string, VehicleKind>(Object.entries(snap ? snap.vehicles : DEMO_VEHICLES));
  const rides = createRideBook({
    network,
    ids: options.ids ?? randomIds,
    vehicleOf: (id) => vehicles.get(id) ?? ((network.store.getVolunteer(id)?.vehicle_seats ?? 0) > 0 ? "car" : "none"),
    emit,
  });
  if (snap) rides.importState(snap.rides);
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
  if (snap) coordinator.importState(snap.coordinator);
  coordinator.subscribe((change) => emit(change));
  const emergency = createEmergencyWorker({ network, emit, restored: snap?.extra?.emergency, speak: agent.deps.voice ? async (prompt, signal) => {
    const wav = await agent.deps.voice!.speak(prompt, "en", signal);
    return wav ? { mime: "audio/wav" as const, sample_rate: agent.deps.voice!.sampleRate, data_base64: wav.toString("base64") } : null;
  } : undefined });
  const core = createCoreSessionBook(network, emergency);

  const push = createPushBook({ vapid: resolveVapid(env, undefined, undefined, snap?.push.vapid), ...(options.pushSender ? { sender: options.pushSender } : {}) });
  if (snap) {
    // Subscriptions only work with the key they were made with; after a key change the phones must turn alerts on again.
    if (snap.push.public_key === push.vapid.publicKey) push.importState(snap.push.subscriptions);
    else if (Object.keys(snap.push.subscriptions).length) console.log("[persist] VAPID key changed since the snapshot: dropped the saved push subscriptions (volunteers re-enable alerts in the app).");
  }
  wireAlertPushes(network, push);
  const onRide = ridePushListener(network, push, snap?.rides ?? []);
  listeners.add((change) => onRide(change as { kind: string; ride?: Ride }));
  const twilio = twilioConfig(env);
  const calls = createCallBook({ network, rides, twilio, baseUrl: publicBaseUrl(env), ...(options.fetch ? { fetch: options.fetch } : {}) });
  if (snap) calls.importState(snap.calls);
  const speech = createSpeech(env, options.fetch ? { fetch: options.fetch as typeof fetch } : {});
  // The demo dispatcher can talk back to Clara on the call (Claude answers from the scene; messages reach the box).
  const dispatchModel = env.ANTHROPIC_API_KEY?.trim() ? createClaudeModel({ apiKey: env.ANTHROPIC_API_KEY.trim() }) : null;
  const talk = dispatchModel
    ? {
        answer: async (incidentId: string, history: Parameters<typeof answerDispatcher>[2], words: string) => {
          const scene = sceneFacts(network, incidentId, REPORT_OPTIONS.timeZone);
          return scene ? answerDispatcher(dispatchModel, scene, history, words) : { reply: "I no longer have this scene's details.", relay: null, end: false };
        },
        relay: (boxId: string, incidentId: string, text: string) => emit({ kind: "push", box_id: boxId, push: { type: "responder.message", incident_id: incidentId, from: "the 911 dispatcher", text } }),
      }
    : null;
  const demo911 = createDemo911({ network, twilio, number: env.CLARA_DEMO_911_NUMBER, timers: options.timers !== false, speech, baseUrl: publicBaseUrl(env), talk, ...(options.fetch ? { fetch: options.fetch } : {}) });
  // Demo assumption: a guided step that uses a kit item counts as one used (see lib/autoSupply.ts).
  const autoSupply = createAutoSupply({ network, scenarios });
  const photon = photonConfig(env);
  const texts = createTextBook({ network, rides, photon, ...(options.fetch ? { fetch: options.fetch } : {}) });
  // Other books are saved under `extra` once they expose exportState/importState (duck-typed, so adding one is enough).
  const extras: Record<string, Partial<Persistable>> = { texts: texts as Partial<Persistable>, emergency };
  if (snap?.extra) {
    for (const [name, value] of Object.entries(snap.extra)) {
      if (name === "emergency") continue; // Restored before subscribing, so no stale question is emitted.
      try {
        extras[name]?.importState?.(value);
      } catch (error) {
        console.error(`[persist] couldn't restore ${name}; it starts empty:`, error);
      }
    }
  }
  const onRideText = wireTexts(network, texts);
  listeners.add((change) => onRideText(change as { kind: string; ride?: Ride }));

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
  console.log(`[clara] network ${snap ? `restored from the snapshot saved ${snap.saved_at}` : "seeded"} (${network.store.listBoxes().length} boxes); agent ${agent.describe}; coordinator ${coordinator.describe}; simulated boxes: ${simulatedBoxes.join(", ") || "none"}; push VAPID ${push.vapid.source}; calls ${twilio ? "Twilio" : "not configured (logs only)"}; texts ${photon ? "Photon" : "not configured (logs only)"}`);

  return {
    network,
    agent,
    rides,
    coordinator,
    emergency,
    core,
    cameraEnabled: Boolean(env.CLARA_BOX_TOKEN && env.ANTHROPIC_API_KEY),
    vehicles,
    push,
    calls,
    twilio,
    demo911,
    speech,
    texts,
    photon,
    publicBaseUrl: publicBaseUrl(env),
    messages,
    ambulanceEtaMin,
    maintainerAlerts,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit,
    exportState(): RuntimeState {
      const extra: Record<string, unknown> = {};
      for (const [name, book] of Object.entries(extras)) if (typeof book.exportState === "function") extra[name] = book.exportState();
      return {
        store: network.store.exportState(),
        rides: rides.exportState(),
        vehicles: Object.fromEntries(vehicles),
        messages: structuredClone(Object.fromEntries(messages)),
        maintainer_alerts: structuredClone(maintainerAlerts),
        push: {
          subscriptions: push.exportState(),
          public_key: push.vapid.publicKey,
          // A generated pair is saved with the subscriptions it signs; keys from the environment never are.
          vapid: push.vapid.source === "env" ? null : { publicKey: push.vapid.publicKey, privateKey: push.vapid.privateKey },
        },
        calls: calls.exportState(),
        coordinator: coordinator.exportState(),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
    },
    persistence: { ...PERSISTENCE_OFF },
    simulatedBoxes,
    reportOptions: REPORT_OPTIONS,
    stop: () => {
      timers.forEach(clearInterval);
      coordinator.stop();
      emergency.stop();
      core.clear();
      demo911.stop();
      autoSupply.stop();
    },
  };
}

/** A book whose state can be saved in the snapshot's `extra` section. */
export interface Persistable {
  exportState(): unknown;
  importState(value: unknown): void;
}

/**
 * A runtime from a stored snapshot (unchecked JSON). An unknown version or invalid data is logged loudly and the
 * server starts fresh (demo seed) instead of crashing; `rejected` then says why.
 */
export function restoreRuntime(raw: unknown, options: RuntimeOptions = {}): { runtime: Runtime; restored: Snapshot | null; rejected: string | null } {
  if (raw === null || raw === undefined) return { runtime: createRuntime(options), restored: null, rejected: null };
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) {
    console.error(`[persist] !!! the saved state can't be used (${parsed.reason}); starting fresh with the demo seed.`);
    return { runtime: createRuntime(options), restored: null, rejected: parsed.reason };
  }
  try {
    return { runtime: createRuntime({ ...options, snapshot: parsed.snapshot }), restored: parsed.snapshot, rejected: null };
  } catch (error) {
    const reason = `restore failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    console.error(`[persist] !!! ${reason}; starting fresh with the demo seed.`);
    return { runtime: createRuntime(options), restored: null, rejected: reason };
  }
}

const KEY = Symbol.for("clara.web.runtime");
const BOOT = Symbol.for("clara.web.boot");
const SIGNALS = Symbol.for("clara.web.signals");
type Holder = { [KEY]?: Runtime; [BOOT]?: Promise<Runtime>; [SIGNALS]?: { persistence: Persistence | null } };

/** The process's runtime, created on first use, in memory only. Route handlers use ensureRuntime(). */
export function runtime(): Runtime {
  const g = globalThis as Holder;
  g[KEY] ??= createRuntime();
  return g[KEY];
}

/**
 * The process's runtime once it is ready: without DATABASE_URL at once (in memory, as before); with it, after the
 * saved snapshot has been loaded (the first request after boot waits for that; later ones don't). Never rejects:
 * a database problem is logged and the server runs in memory.
 */
export function ensureRuntime(): Promise<Runtime> {
  const g = globalThis as Holder;
  if (g[KEY]) return Promise.resolve(g[KEY]);
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return Promise.resolve(runtime());
  g[BOOT] ??= bootWithDatabase(url).catch((error: unknown) => {
    console.error("[persist] boot with the database failed; running in memory:", error);
    return runtime();
  });
  return g[BOOT];
}

async function bootWithDatabase(url: string): Promise<Runtime> {
  const g = globalThis as Holder;
  const persistence = createPersistence({ url });
  const loaded = await persistence.load();
  if (g[KEY]) return g[KEY]; // a test (or an earlier boot) put one in place meanwhile
  const { runtime: rt, restored, rejected } = restoreRuntime(loaded.raw);
  if (rejected && loaded.ok) await persistence.keepRejected(rejected);
  rt.persistence = persistence.status;
  persistence.attach(rt, restored?.saved_at ?? null);
  g[KEY] = rt;
  installSignalHandlers(persistence);
  console.log(`[persist] ${restored ? `restored the state saved ${restored.saved_at}` : loaded.ok ? "no usable saved state: started fresh" : "database unreachable: running in memory, not saving"}; generation ${persistence.status.generation}.`);
  return rt;
}

/**
 * Render sends SIGTERM before stopping an instance: make one last save, then exit. With NEXT_MANUAL_SIG_HANDLE set
 * (render.yaml) Next leaves the signal to us and we exit after the save; without it Next's own handler shuts down
 * alongside (it first waits for open requests, which gives the save time).
 */
function installSignalHandlers(persistence: Persistence) {
  const g = globalThis as Holder;
  if (g[SIGNALS]) {
    g[SIGNALS].persistence = persistence;
    return;
  }
  const holder = { persistence: persistence as Persistence | null };
  g[SIGNALS] = holder;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`[persist] ${signal}: saving before exit.`);
    void (holder.persistence?.flush() ?? Promise.resolve()).finally(() => {
      if (process.env.NEXT_MANUAL_SIG_HANDLE) process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

/** Tests: swap in a runtime (or clear it with null). */
export function setRuntime(next: Runtime | null): void {
  const g = globalThis as Holder;
  g[KEY]?.stop();
  delete g[BOOT];
  if (next) g[KEY] = next;
  else delete g[KEY];
}

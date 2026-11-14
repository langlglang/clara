import type { Incident } from "@clara/contracts";
import { z } from "zod";
import type { Network, NetworkChange } from "@clara/network";
import { createToolLayer, type IncidentState, type ToolLayer } from "./tools.js";
import { rulesRunner } from "./rules.js";
import type { CareThreshold, Need } from "./care.js";
import type { Runner } from "./runner.js";
import type { AgentName, CoordinatorChange, CoordinatorEnv, CoordinatorLog, CoordinatorMode, Logger, RidesAdapter } from "./types.js";

/** Wait this long after the last trigger before running (several changes arrive together). */
export const DEBOUNCE_MS = 3_000;
/** While an incident is open, run at least this often. */
export const PERIODIC_MS = 45_000;
export const MAX_RUNS_PER_INCIDENT = 10;
export const RUN_DEADLINE_MS = 60_000;
/** How often the coordinator checks escalation level and the periodic timer. */
export const CHECK_MS = 1_000;

export interface CoordinatorOptions {
  network: Network;
  rides?: RidesAdapter;
  /** Demo time-to-care threshold per need (the scenario's care block); DEFAULT_CARE otherwise. */
  careFor?: (need: Need) => CareThreshold | undefined;
  /** CLARA_AMBULANCE_ETA_MIN (simulated 911 call): minutes from SOS to the scene; null when not set. */
  ambulanceEtaMin?: number | null;
  /** A chat model instance or model name for the deep agent (default CLARA_COORDINATOR_MODEL or claude-opus-5-5). */
  model?: unknown;
  clock?: () => Date;
  log?: Logger;
  /** Force on/off; default from env (off without ANTHROPIC_API_KEY or with CLARA_COORDINATOR=off). */
  enabled?: boolean;
  env?: CoordinatorEnv;
  /** Inject a planner (tests). Overrides the deep agent / rules choice; mode is taken from `mode` or "deep_agent". */
  runner?: Runner;
  mode?: CoordinatorMode;
  /** Start the periodic check interval (default true). Tests call `check()` themselves. */
  timers?: boolean;
  debounceMs?: number;
  deadlineMs?: number;
  maxRuns?: number;
}

export interface Coordinator {
  readonly mode: CoordinatorMode;
  readonly label: string;
  readonly model: string | null;
  readonly describe: string;
  getLog(incidentId: string): CoordinatorLog | undefined;
  subscribe(listener: (change: CoordinatorChange) => void): () => void;
  /** Ask for a run (debounced). Returns false when it won't run (off, closed, run limit). */
  trigger(incidentId: string, reason: string): boolean;
  /** Escalation-level and periodic checks; the interval calls it every second. */
  check(now?: Date): void;
  /** Resolves when no run is pending or in flight (tests). */
  idle(): Promise<void>;
  stop(): void;
  /** Logs, memory, counters and bookkeeping per incident, as plain JSON (persistence snapshots). */
  exportState(): CoordinatorSnapshot;
  /**
   * Restores exportState's output (validated; throws on invalid data, changing nothing). A run that was queued or in
   * flight when the snapshot was taken is marked interrupted; the next trigger or periodic check plans again.
   */
  importState(snapshot: unknown): void;
}

const RunSnapshotSchema = z.looseObject({ run: z.number(), outcome: z.enum(["running", "ok", "error", "timeout"]), ended_at: z.string().nullable(), error: z.string().nullable() });
const LogSnapshotSchema = z.looseObject({
  incident_id: z.string().min(1),
  status: z.enum(["idle", "queued", "running", "stopped"]),
  stopped_reason: z.string().nullable(),
  plan: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  notes: z.array(z.unknown()),
  flags: z.array(z.unknown()),
  subagents: z.array(z.unknown()),
  memory: z.array(z.unknown()),
  runs: z.array(RunSnapshotSchema),
  extra_alerts: z.number().int().min(0),
  updated_at: z.string(),
});
export const CoordinatorSnapshotSchema = z.object({
  slots: z.array(
    z.object({
      incident_id: z.string().min(1),
      log: LogSnapshotSchema,
      kit_requests: z.array(z.string()),
      ride_proposals: z.array(z.looseObject({ ride_id: z.string(), driver_id: z.string() })),
      last_estimate: z.looseObject({ run: z.number() }).nullable(),
      ride_requests: z.number().int().min(0),
      agent_memory: z.looseObject({}).nullable(),
      runs: z.number().int().min(0),
      last_run_at: z.number(),
      level: z.string(),
      alert_states: z.record(z.string(), z.string()),
      closed: z.boolean(),
    }),
  ),
});
export type CoordinatorSnapshot = z.infer<typeof CoordinatorSnapshotSchema>;

/** Resolves the mode from the environment: CLARA_COORDINATOR=off|rules|on (default on), deep agent needs a key. */
export function resolveMode(env: CoordinatorEnv, enabled?: boolean): CoordinatorMode {
  const setting = (env.CLARA_COORDINATOR ?? "on").trim().toLowerCase();
  if (enabled === false || setting === "off") return "off";
  if (setting === "rules") return "rules";
  if (!env.ANTHROPIC_API_KEY?.trim()) return "off";
  return "deep_agent";
}

const LABEL: Record<CoordinatorMode, string> = { deep_agent: "deep agent", rules: "rules", off: "off" };

interface Slot {
  state: IncidentState;
  timer: ReturnType<typeof setTimeout> | null;
  pending: string[];
  running: Promise<void> | null;
  runs: number;
  lastRunAt: number;
  level: string;
  alertStates: Map<string, string>;
  closed: boolean;
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const { network } = options;
  const env: CoordinatorEnv = options.env ?? (process.env as CoordinatorEnv);
  const clock = options.clock ?? network.clock;
  const log = options.log ?? ((line: string) => console.log(line));
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const deadlineMs = options.deadlineMs ?? RUN_DEADLINE_MS;
  const maxRuns = options.maxRuns ?? MAX_RUNS_PER_INCIDENT;

  const mode: CoordinatorMode = options.runner ? (options.enabled === false ? "off" : (options.mode ?? "deep_agent")) : resolveMode(env, options.enabled);
  const modelName = mode === "deep_agent" ? (typeof options.model === "string" ? options.model : options.model ? "custom model" : env.CLARA_COORDINATOR_MODEL?.trim() || "claude-opus-5-5") : null;

  let runnerPromise: Promise<Runner> | null = null;
  const getRunner = (): Promise<Runner> => {
    if (options.runner) return Promise.resolve(options.runner);
    if (mode === "rules") return Promise.resolve(rulesRunner);
    // The LangChain stack loads only when the deep agent is actually used.
    runnerPromise ??= import("./agent.js").then((m) =>
      m.deepAgentRunner({ model: (options.model as never) ?? modelName ?? undefined, modelName: modelName ?? m.DEFAULT_MODEL, apiKey: env.ANTHROPIC_API_KEY, effort: (env.CLARA_COORDINATOR_EFFORT as "low" | "medium" | undefined) ?? "low" }),
    );
    return runnerPromise;
  };

  const slots = new Map<string, Slot>();
  const listeners = new Set<(change: CoordinatorChange) => void>();
  let stopped = false;

  const emit = (incidentId: string, slot: Slot) => {
    slot.state.log.updated_at = clock().toISOString();
    const change: CoordinatorChange = { kind: "coordinator", incident_id: incidentId, log: structuredClone(slot.state.log) };
    for (const l of [...listeners]) {
      try {
        l(change);
      } catch {
        // A broken listener never breaks the coordinator.
      }
    }
  };

  const slotFor = (incident: Incident): Slot => {
    let slot = slots.get(incident.incident_id);
    if (!slot) {
      const at = clock().toISOString();
      slot = {
        state: {
          log: { incident_id: incident.incident_id, mode, label: LABEL[mode], model: modelName, status: "idle", stopped_reason: null, plan: [], actions: [], notes: [], flags: [], subagents: [], memory: [], runs: [], extra_alerts: 0, time_to_care: null, ride_request: null, updated_at: at },
          kitRequests: new Set(),
          rideProposals: [],
        },
        timer: null,
        pending: [],
        running: null,
        runs: 0,
        lastRunAt: 0,
        level: network.incident(incident.incident_id)?.escalation.level ?? "first",
        alertStates: new Map(incident.alerts.map((a) => [a.alert_id, a.state])),
        closed: incident.closed !== null,
      };
      slots.set(incident.incident_id, slot);
    }
    return slot;
  };

  const stopSlot = (incidentId: string, slot: Slot, reason: string) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.pending = [];
    if (slot.state.log.status !== "stopped" && !slot.running) {
      slot.state.log.status = "stopped";
      slot.state.log.stopped_reason = reason;
      emit(incidentId, slot);
    } else if (!slot.state.log.stopped_reason) slot.state.log.stopped_reason = reason;
  };

  function schedule(incidentId: string, slot: Slot, reason: string): boolean {
    if (mode === "off" || stopped || slot.closed) return false;
    if (slot.runs >= maxRuns) {
      stopSlot(incidentId, slot, `Run limit reached (${maxRuns} runs).`);
      return false;
    }
    if (!slot.pending.includes(reason)) slot.pending.push(reason);
    if (slot.running) return true; // runs again after the current one
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => void start(incidentId, slot), debounceMs);
    if (slot.state.log.status === "idle") {
      slot.state.log.status = "queued";
      emit(incidentId, slot);
    }
    return true;
  }

  async function start(incidentId: string, slot: Slot) {
    slot.timer = null;
    if (slot.running || stopped || slot.closed) return;
    if (slot.runs >= maxRuns) return stopSlot(incidentId, slot, `Run limit reached (${maxRuns} runs).`);
    const trigger = slot.pending.splice(0);
    if (trigger.length === 0) return;
    slot.runs += 1;
    const run = slot.runs;
    const started = clock();
    slot.lastRunAt = started.getTime();
    const entry = { run, trigger, started_at: started.toISOString(), ended_at: null as string | null, ms: null as number | null, outcome: "running" as const as CoordinatorLog["runs"][number]["outcome"], error: null as string | null, model: modelName };
    slot.state.log.runs.push(entry);
    slot.state.log.status = "running";
    emit(incidentId, slot);

    const controller = new AbortController();
    const changed = () => emit(incidentId, slot);
    const layer = createToolLayer({ network, rides: options.rides, careFor: options.careFor, ambulanceEtaMin: options.ambulanceEtaMin ?? null, incidentId, state: slot.state, run, signal: controller.signal, clock, changed });
    const toolsFor = (agent: AgentName): ToolLayer => ({
      get_incident: () => layer.get_incident(agent),
      list_candidates: () => layer.list_candidates(agent),
      get_nearby_kits: () => layer.get_nearby_kits(agent),
      get_rides: () => layer.get_rides(agent),
      get_site_overview: () => layer.get_site_overview(agent),
      estimate_time_to_care: () => layer.estimate_time_to_care(agent),
      alert_volunteers: (a) => layer.alert_volunteers(a, agent),
      request_kit: (a) => layer.request_kit(a, agent),
      propose_ride: (a) => layer.propose_ride(a, agent),
      request_ride: (a) => layer.request_ride(a, agent),
      post_dispatch_note: (a) => layer.post_dispatch_note(a, agent),
      flag_for_dispatcher: (a) => layer.flag_for_dispatcher(a, agent),
    });

    let deadline: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<"timeout">((resolve) => {
      deadline = setTimeout(() => {
        controller.abort(new Error("coordinator run deadline"));
        resolve("timeout");
      }, deadlineMs);
    });

    const work = (async () => {
      const runner = await getRunner();
      await runner({
        incidentId,
        run,
        trigger,
        tools: layer,
        toolsFor,
        signal: controller.signal,
        state: slot.state,
        setPlan: (items) => {
          slot.state.log.plan = items.slice(0, 12);
          changed();
        },
        recordSubagent: (name, task, result) => {
          slot.state.log.subagents.push({ at: clock().toISOString(), run, name, task, result });
          if (slot.state.log.subagents.length > 50) slot.state.log.subagents.shift();
          changed();
        },
        setAgentMemory: (memory) => {
          slot.state.agentMemory = memory;
        },
        setMemory: (files) => {
          slot.state.log.memory = files.slice(0, 20);
          changed();
        },
        log,
      });
      return "ok" as const;
    })();

    slot.running = (async () => {
      let outcome: "ok" | "error" | "timeout" = "ok";
      let error: string | null = null;
      try {
        outcome = await Promise.race([work, timedOut]);
        if (outcome === "timeout") error = `Stopped at the ${Math.round(deadlineMs / 1000)} s deadline.`;
      } catch (e) {
        outcome = controller.signal.aborted ? "timeout" : "error";
        error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      } finally {
        if (deadline) clearTimeout(deadline);
        controller.abort();
      }
      work.catch(() => undefined); // a runner that rejects after the deadline is ignored
      const ended = clock();
      entry.outcome = outcome;
      entry.error = error;
      entry.ended_at = ended.toISOString();
      entry.ms = ended.getTime() - started.getTime();
      if (outcome !== "ok") log(`[coordinator] ${incidentId} run ${run} ${outcome}: ${error}`);
      slot.running = null;
      slot.state.log.status = "idle";
      if (slot.closed) {
        slot.state.log.status = "stopped";
        slot.state.log.stopped_reason ??= "Incident closed.";
      } else if (slot.runs >= maxRuns) {
        slot.state.log.status = "stopped";
        slot.state.log.stopped_reason = `Run limit reached (${maxRuns} runs).`;
      }
      emit(incidentId, slot);
      if (slot.pending.length && slot.state.log.status === "idle") {
        const again = slot.pending.splice(0);
        for (const r of again) schedule(incidentId, slot, r);
      }
    })();
    await slot.running;
  }

  function onIncident(incident: Incident) {
    const known = slots.has(incident.incident_id);
    const slot = slotFor(incident);
    if (incident.closed !== null) {
      if (!slot.closed) {
        slot.closed = true;
        stopSlot(incident.incident_id, slot, "Incident closed.");
      }
      return;
    }
    if (!known) {
      schedule(incident.incident_id, slot, "incident opened");
      return;
    }
    for (const a of incident.alerts) {
      const before = slot.alertStates.get(a.alert_id);
      slot.alertStates.set(a.alert_id, a.state);
      if (before !== a.state && (a.state === "declined" || a.state === "expired")) schedule(incident.incident_id, slot, `${a.volunteer_name} ${a.state}`);
    }
  }

  /** An SOS (re)opened or a tourniquet went on: time to care changes, so plan again. */
  function onEvent(event: Extract<NetworkChange, { kind: "event" }>["event"]) {
    const reason = event.type === "sos.opened" ? "SOS opened" : event.type === "timer.started" && event.timer === "tourniquet" ? "tourniquet on" : null;
    if (!reason) return;
    const entry = network.store.openIncidentForBox(event.box_id);
    if (!entry || entry.incident.closed !== null) return;
    const known = slots.has(entry.incident.incident_id);
    const slot = slotFor(entry.incident);
    schedule(entry.incident.incident_id, slot, known ? reason : "incident opened");
  }

  const off = mode === "off" ? () => undefined : network.subscribe((change: NetworkChange) => {
    try {
      if (change.kind === "event") return onEvent(change.event);
      if (change.kind !== "incident") return;
      onIncident(change.incident);
    } catch (error) {
      log(`[coordinator] change handling failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  function check(now: Date = clock()) {
    if (mode === "off" || stopped) return;
    for (const v of network.incidents()) {
      if (v.incident.closed !== null) continue;
      const slot = slots.get(v.incident.incident_id);
      if (!slot) {
        onIncident(v.incident);
        continue;
      }
      if (v.escalation.level !== slot.level) {
        slot.level = v.escalation.level;
        schedule(v.incident.incident_id, slot, `escalation: ${v.escalation.level} wave`);
      } else if (!slot.running && !slot.timer && slot.lastRunAt > 0 && now.getTime() - slot.lastRunAt >= PERIODIC_MS) {
        schedule(v.incident.incident_id, slot, "periodic check");
      }
    }
  }

  let interval: ReturnType<typeof setInterval> | null = null;
  if (mode !== "off" && options.timers !== false) {
    interval = setInterval(() => {
      try {
        check();
      } catch (error) {
        log(`[coordinator] check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, CHECK_MS);
    interval.unref?.();
  }

  return {
    mode,
    label: LABEL[mode],
    model: modelName,
    describe: mode === "deep_agent" ? `deep agent (${modelName})` : mode,
    getLog: (id) => {
      const slot = slots.get(id);
      return slot ? structuredClone(slot.state.log) : undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    trigger(incidentId, reason) {
      const view = network.incident(incidentId);
      if (!view) return false;
      const slot = slotFor(view.incident);
      return schedule(incidentId, slot, reason);
    },
    check,
    async idle() {
      for (let i = 0; i < 1000; i++) {
        const busy = [...slots.values()].filter((s) => s.running || s.timer);
        if (busy.length === 0) return;
        await Promise.all(busy.map((s) => s.running ?? new Promise((r) => setTimeout(r, 5))));
      }
    },
    stop() {
      stopped = true;
      off();
      if (interval) clearInterval(interval);
      for (const s of slots.values()) if (s.timer) clearTimeout(s.timer);
    },
    exportState() {
      return structuredClone({
        slots: [...slots.entries()].map(([incident_id, s]) => ({
          incident_id,
          log: s.state.log,
          kit_requests: [...s.state.kitRequests],
          ride_proposals: s.state.rideProposals,
          last_estimate: s.state.lastEstimate ?? null,
          ride_requests: s.state.rideRequests ?? 0,
          agent_memory: s.state.agentMemory ?? null,
          runs: s.runs,
          last_run_at: s.lastRunAt,
          level: s.level,
          alert_states: Object.fromEntries(s.alertStates),
          closed: s.closed,
        })),
      }) as unknown as CoordinatorSnapshot;
    },
    importState(snapshot) {
      const parsed = CoordinatorSnapshotSchema.parse(snapshot);
      for (const s of slots.values()) if (s.timer) clearTimeout(s.timer);
      slots.clear();
      const at = clock().toISOString();
      for (const raw of structuredClone(parsed.slots)) {
        const log = raw.log as unknown as CoordinatorLog;
        // A run cut off by the restart: say so instead of showing it running forever.
        for (const r of log.runs) {
          if (r.outcome !== "running") continue;
          r.outcome = "error";
          r.error = "Interrupted by a server restart.";
          r.ended_at = at;
        }
        const interrupted = log.status === "running" || log.status === "queued";
        if (interrupted) log.status = raw.closed ? "stopped" : "idle";
        // An open incident whose run was cut off is due a periodic check at once.
        if (interrupted && !raw.closed) raw.last_run_at = Math.max(1, Date.parse(at) - PERIODIC_MS);
        slots.set(raw.incident_id, {
          state: {
            log,
            kitRequests: new Set(raw.kit_requests),
            rideProposals: raw.ride_proposals as unknown as IncidentState["rideProposals"],
            ...(raw.last_estimate ? { lastEstimate: raw.last_estimate as unknown as NonNullable<IncidentState["lastEstimate"]> } : {}),
            rideRequests: raw.ride_requests,
            ...(raw.agent_memory ? { agentMemory: raw.agent_memory as IncidentState["agentMemory"] } : {}),
          },
          timer: null,
          pending: [],
          running: null,
          runs: raw.runs,
          lastRunAt: raw.last_run_at,
          level: raw.level,
          alertStates: new Map(Object.entries(raw.alert_states)),
          closed: raw.closed,
        });
      }
    },
  };
}

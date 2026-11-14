import type { Network } from "@clara/network";
import type { TimeToCare } from "./care.js";

/** How the coordinator plans: the LangChain deep agent, the deterministic rules planner, or not at all. */
export type CoordinatorMode = "deep_agent" | "rules" | "off";

/** Who made a tool call: the main coordinator or one of its subagents. */
export type AgentName = "coordinator" | "responder-scout" | "logistics" | "time-to-care" | "general-purpose" | "rules";

export interface PlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolCallEntry {
  at: string;
  run: number;
  agent: AgentName;
  tool: string;
  kind: "read" | "act";
  /** Short, human-readable summary of the arguments. */
  args: string;
  ok: boolean;
  /** Short summary of what happened (or why it was refused). */
  result: string;
  /** For acts: the coordinator's stated reason. */
  reason: string | null;
}

export interface NoteEntry {
  at: string;
  run: number;
  text: string;
}

export interface FlagEntry {
  at: string;
  run: number;
  reason: string;
}

export interface SubagentEntry {
  at: string;
  run: number;
  name: string;
  task: string;
  result: string;
}

export interface MemoryFile {
  path: string;
  preview: string;
  modified_at: string | null;
}

export interface RunEntry {
  run: number;
  trigger: string[];
  started_at: string;
  ended_at: string | null;
  ms: number | null;
  outcome: "running" | "ok" | "error" | "timeout";
  error: string | null;
  model: string | null;
}

/** Everything the coordinator did for one incident, for the dispatch console. */
export interface CoordinatorLog {
  incident_id: string;
  mode: CoordinatorMode;
  /** "deep agent" or "rules", as shown on the console badge. */
  label: string;
  model: string | null;
  status: "idle" | "queued" | "running" | "stopped";
  /** Why it stopped (run limit, incident closed), or null. */
  stopped_reason: string | null;
  plan: PlanItem[];
  actions: ToolCallEntry[];
  notes: NoteEntry[];
  flags: FlagEntry[];
  subagents: SubagentEntry[];
  /** The deep agent's virtual filesystem (its working notes), previews only. */
  memory: MemoryFile[];
  runs: RunEntry[];
  /** Alerts the coordinator added beyond the automatic waves. */
  extra_alerts: number;
  /** The latest estimate_time_to_care result (simulated ambulance vs volunteer driver), or null before one. */
  time_to_care?: TimeToCare | null;
  /** The ride the coordinator requested itself with request_ride (offers sent without prior approval), or null. */
  ride_request?: RideRequestEntry | null;
  updated_at: string;
}

export interface RideRequestEntry {
  at: string;
  run: number;
  ride_id: string;
  reason: string;
  offered_to: string[];
  verdict: string;
}

export interface CoordinatorChange {
  kind: "coordinator";
  incident_id: string;
  log: CoordinatorLog;
}

/** A driver option as the ride book describes it (subset of apps/web RideView's DriverOption). */
export interface RideDriverOption {
  driver_id: string;
  name: string;
  vehicle: string;
  seats: number;
  distance_km: number;
  pickup_minutes: number;
  suitable: boolean;
  reasons: string[];
  hospital_minutes?: number;
  carries_lying_down?: boolean;
  carries_wheelchair?: boolean;
}

/** What a ride to hospital would look like for an incident, without opening a ride (for estimate_time_to_care). */
export interface RidePreview {
  hospital: { name: string; drive_minutes: number } | null;
  seats_needed: number;
  /** Free drivers in range (suitable or not). */
  drivers: RideDriverOption[];
}

/** A ride as the ride book describes it (subset of apps/web RideView). */
export interface RideSummary {
  ride_id: string;
  incident_id: string;
  state: "planning" | "offered" | "accepted" | "cancelled";
  note: string | null;
  offers: { driver_id: string; driver_name: string; state: string }[];
  winner: { driver_id: string; driver_name: string; pickup_minutes: number } | null;
  suggested: RideDriverOption | null;
  backups: RideDriverOption[];
  hospital_minutes: number | null;
}

/**
 * The ride operations the coordinator may use. Rides live in apps/web (lib/rides.ts); the web app passes its ride
 * book here. There is deliberately no approve: offers to drivers only go out when a dispatcher approves, or through
 * requestNow when request_ride's time-to-care bar is met (code-checked in tools.ts).
 */
export interface RidesAdapter {
  forIncident(incidentId: string): RideSummary | undefined;
  /** Opens (or returns) the incident's ride plan in `planning`; it offers nothing to anyone. */
  request(incidentId: string, note: string | null): RideSummary | undefined;
  /** Hospital and free drivers for an incident, without opening anything. */
  preview?(incidentId: string): RidePreview | undefined;
  /**
   * Opens the ride (or reuses a plan with no open offers) and sends offers to the best suitable drivers right away
   * (push + call fallback, first accept wins). Only request_ride calls this, behind its time-to-care checks.
   */
  requestNow?(incidentId: string, note: string | null): { ok: true; ride: RideSummary; offered_to: string[] } | { ok: false; error: string };
}

/** A dispatcher-facing ride proposal (the dispatcher still approves or ignores it). */
export interface RideProposal {
  at: string;
  ride_id: string;
  driver_id: string;
  driver_name: string;
  reason: string;
}

export interface CoordinatorEnv {
  ANTHROPIC_API_KEY?: string;
  CLARA_COORDINATOR?: string;
  CLARA_COORDINATOR_MODEL?: string;
  [key: string]: string | undefined;
}

export type Logger = (line: string) => void;

export type { Network };

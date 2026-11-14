import type { Network } from "@clara/network";

/** How the coordinator plans: the LangChain deep agent, the deterministic rules planner, or not at all. */
export type CoordinatorMode = "deep_agent" | "rules" | "off";

/** Who made a tool call: the main coordinator or one of its subagents. */
export type AgentName = "coordinator" | "responder-scout" | "logistics" | "general-purpose" | "rules";

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
  updated_at: string;
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
 * book here. There is deliberately no approve: offers to drivers only go out when a dispatcher approves.
 */
export interface RidesAdapter {
  forIncident(incidentId: string): RideSummary | undefined;
  /** Opens (or returns) the incident's ride plan in `planning`; it offers nothing to anyone. */
  request(incidentId: string, note: string | null): RideSummary | undefined;
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

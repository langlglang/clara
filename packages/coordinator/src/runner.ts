import type { IncidentState, ToolLayer } from "./tools.js";
import type { AgentName, Logger, MemoryFile, PlanItem } from "./types.js";

/** What one planning run gets: the enforced tool layer and ways to report its plan and subagent work. */
export interface RunInput {
  incidentId: string;
  run: number;
  /** Why this run started (e.g. "incident opened", "Amina declined"). */
  trigger: string[];
  /** Tools bound to the main coordinator; `toolsFor(agent)` attributes calls to a subagent. */
  tools: ToolLayer;
  toolsFor(agent: AgentName): ToolLayer;
  /** Aborted at the run deadline; tools refuse after that. */
  signal: AbortSignal;
  /** Read-only view of what happened so far (earlier runs' actions, notes, flags). */
  state: Readonly<IncidentState>;
  setPlan(items: PlanItem[]): void;
  recordSubagent(name: string, task: string, result: string): void;
  setMemory(files: MemoryFile[]): void;
  /** Keeps the deep agent's filesystem and todos for its next run on this incident (saved in persistence snapshots). */
  setAgentMemory(memory: { files?: unknown; todos?: PlanItem[] }): void;
  log: Logger;
}

/** One planning run. Resolves when done; may reject (logged, never thrown into the network). */
export type Runner = (input: RunInput) => Promise<void>;

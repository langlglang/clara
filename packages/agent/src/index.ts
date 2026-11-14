import type Anthropic from "@anthropic-ai/sdk";
import type { TurnRequest, TurnResponse } from "@clara/contracts";
import { createAssistant, type Assistant } from "./assistant.js";
import { createCartesiaEars, createCartesiaVoice, type Ears, type Voice } from "./cartesia.js";
import { BACKUP_AFTER_MS, createHedgedAssistant } from "./hedge.js";
import { DEFAULT_BACKUP_MODEL, DEFAULT_MAIN_MODEL, createClaudeModel, createKeywordStubModel } from "./model.js";
import { TURN_BUDGET_MS, handleTurn, type TurnDeps } from "./turn.js";

export { handleTurn, FIXED_LINES, TURN_BUDGET_MS, type TurnDeps } from "./turn.js";
export { createAnthropicVisionInspector, parseVisibleObservation, type VisionInspector } from "./vision.js";
export { createAssistant, parseReply, RejectedReply, type Assistant, type AssistantResult } from "./assistant.js";
export { createHedgedAssistant, BACKUP_AFTER_MS } from "./hedge.js";
export { createClaudeModel, createKeywordStubModel, DEFAULT_MAIN_MODEL, DEFAULT_BACKUP_MODEL, type ReplyModel, type ModelRequest, type ModelOutput } from "./model.js";
export { createCartesiaEars, createCartesiaVoice, type Ears, type Voice } from "./cartesia.js";
export { replyJsonSchema, replyZodSchema, type ModelReply } from "./schema.js";
export { checkHonesty, HONESTY_RULES } from "./honesty.js";
export { SYSTEM_PROMPT, turnContext } from "./prompt.js";

/** Environment-like config. Keys stay on the server; missing or "none" values mean "not set". */
export interface ClaraAgentEnv {
  ANTHROPIC_API_KEY?: string;
  CARTESIA_API_KEY?: string;
  CARTESIA_VOICE_ID?: string;
  CLARA_MAIN_MODEL?: string;
  /** "none" turns the backup off. */
  CLARA_BACKUP_MODEL?: string;
  CLARA_BACKUP_AFTER_MS?: string;
  CLARA_TURN_BUDGET_MS?: string;
  /** "stub" uses the keyword stub when there is no Anthropic key (demo only). */
  CLARA_MODEL?: string;
  [name: string]: string | undefined;
}

export interface ClaraAgentOptions {
  /** For tests: Cartesia requests go here. */
  fetch?: typeof fetch;
  /** For tests: an Anthropic client (or fake) instead of one built from the key. */
  anthropic?: Anthropic;
  log?: (line: string) => void;
  /** Server-owned, source-linked demo text for a scenario and step ID. */
  guidance?: (scenarioId: string, stepId: string) => string | null;
}

export interface ClaraAgent {
  handleTurn(request: TurnRequest, receivedAt?: number, signal?: AbortSignal): Promise<TurnResponse>;
  readonly deps: TurnDeps;
  /** One line for the startup log; never contains a key. */
  readonly describe: string;
}

const set = (env: ClaraAgentEnv, name: string) => {
  const value = env[name]?.trim();
  return value && value.toLowerCase() !== "none" ? value : undefined;
};
const whole = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
};

/** Builds the model, ears and voice from env-like config. Expects a validated TurnRequest (TurnRequestSchema). */
export function createClaraAgent(env: ClaraAgentEnv, options: ClaraAgentOptions = {}): ClaraAgent {
  const anthropicKey = set(env, "ANTHROPIC_API_KEY");
  const cartesiaKey = set(env, "CARTESIA_API_KEY");
  const mainModel = set(env, "CLARA_MAIN_MODEL") ?? DEFAULT_MAIN_MODEL;
  const backupModel = set(env, "CLARA_BACKUP_MODEL") ?? DEFAULT_BACKUP_MODEL;
  const backupOff = env.CLARA_BACKUP_MODEL?.trim().toLowerCase() === "none";
  const after = whole(set(env, "CLARA_BACKUP_AFTER_MS"), BACKUP_AFTER_MS);

  let assistant: Assistant | null = null;
  let describeModel = "none (turns get a fixed line)";
  if (anthropicKey || options.anthropic) {
    const claude = (model: string) => createAssistant(createClaudeModel({ apiKey: anthropicKey, model, client: options.anthropic }));
    assistant = backupOff ? claude(mainModel) : createHedgedAssistant({ main: claude(mainModel), backup: claude(backupModel), backupAfterMs: after });
    describeModel = backupOff ? mainModel : `${mainModel} (backup ${backupModel} after ${after} ms)`;
  } else if (set(env, "CLARA_MODEL") === "stub") {
    assistant = createAssistant(createKeywordStubModel());
    describeModel = "keyword stub (demo only)";
  }
  const fetchImpl = options.fetch ?? fetch;
  const ears: Ears | null = cartesiaKey ? createCartesiaEars({ apiKey: cartesiaKey, fetchImpl }) : null;
  const voice: Voice | null = cartesiaKey ? createCartesiaVoice({ apiKey: cartesiaKey, voiceId: set(env, "CARTESIA_VOICE_ID"), fetchImpl }) : null;
  const deps: TurnDeps = { assistant, ears, voice, guidance: options.guidance, budgetMs: whole(set(env, "CLARA_TURN_BUDGET_MS"), TURN_BUDGET_MS), log: options.log };
  return {
    deps,
    describe: `model: ${describeModel}; speech: ${cartesiaKey ? "Cartesia" : "none (audio turns get a fixed line; text turns work)"}`,
    handleTurn: (request, receivedAt, signal) => handleTurn(request, deps, receivedAt, signal),
  };
}

import { readFileSync } from "node:fs";
import { ScenarioSchema, checkScenario, type Scenario } from "@clara/contracts";

/** Parses and checks a scenario: every `next` and `start` must name a real step. Throws otherwise. */
export function parseScenario(json: unknown): Scenario {
  return checkScenario(ScenarioSchema.parse(json));
}

/** Loads a scenario file (content/scenarios/*.json). */
export function loadScenario(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")));
}

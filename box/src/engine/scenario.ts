import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ScenarioSchema, ScenarioTranslationSchema, checkScenario, type Scenario, type ScenarioTranslation } from "@clara/contracts";

/** Parses and checks a scenario: every `next` and `start` must name a real step. Throws otherwise. */
export function parseScenario(json: unknown): Scenario {
  return checkScenario(ScenarioSchema.parse(json));
}

/** Loads a scenario file (content/scenarios/*.json). */
export function loadScenario(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")));
}

/** Languages with scenario translations, as folders next to the scenarios (content/scenarios/es/). */
export const TRANSLATED_LANGUAGES = ["es"] as const;

/**
 * The translations of one scenario file (content/scenarios/<language>/<same file name>), for each language that
 * has one. A broken translation is skipped (the box keeps English for it); `log` says why.
 */
export function loadTranslations(scenarioPath: string, log: (line: string) => void = () => {}): ScenarioTranslation[] {
  const found: ScenarioTranslation[] = [];
  for (const language of TRANSLATED_LANGUAGES) {
    const path = join(dirname(scenarioPath), language, basename(scenarioPath));
    if (!existsSync(path)) continue;
    try {
      const t = ScenarioTranslationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (t.language !== language) throw new Error(`says language ${t.language}`);
      if (t.status !== "checked") log(`translation ${language}/${basename(scenarioPath)} is a DRAFT: not checked by a fluent speaker`);
      found.push(t);
    } catch (error) {
      log(`translation ${path} not loaded: ${(error as Error).message}`);
    }
  }
  return found;
}

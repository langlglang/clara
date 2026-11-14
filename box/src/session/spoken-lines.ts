import { localizeScenario, type Scenario, type ScenarioTranslation } from "@clara/contracts";
import { LOCAL_LINES, LOCAL_LINES_ES } from "../voice/voice-loop.js";
import { GREETINGS, LINES, LINES_ES } from "./lines.js";
import { TURN_LINES } from "./text-turn.js";

/**
 * Every line the box can say in its own words, in each language it has: fixed lines, greetings, step text and
 * questions. The box voices these in Clara's Cartesia voice ahead of time, so they play at once and offline too.
 * Lines with names or numbers in them (a responder's message) are voiced when they come up.
 */
export function spokenLines(o: { scenarios: readonly Scenario[]; translations: readonly ScenarioTranslation[]; countdownSeconds?: number }): { text: string; language: string }[] {
  const seconds = o.countdownSeconds ?? 5;
  const out: { text: string; language: string }[] = [];
  const add = (language: string, ...texts: (string | undefined)[]) => {
    for (const text of texts) if (text?.trim()) out.push({ text, language });
  };
  const fixed = (language: string, lines: Record<string, unknown>) => {
    for (const value of Object.values(lines)) if (typeof value === "string") add(language, value);
  };
  const languages = ["en", ...new Set(o.translations.map((t) => t.language))];
  for (const language of languages) {
    const es = language.startsWith("es");
    // The greeting first: it is the first thing anyone hears.
    add(language, GREETINGS[language]);
    fixed(language, es ? LINES_ES : LINES);
    add(language, (es ? LINES_ES : LINES).countdown(seconds));
    fixed(language, es ? LOCAL_LINES_ES : LOCAL_LINES);
    if (!es) fixed(language, TURN_LINES);
    for (const scenario of o.scenarios) {
      const local = language === "en" ? scenario : localizeScenario(scenario, o.translations.find((t) => t.scenario_id === scenario.scenario_id && t.language === language));
      add(language, ...local.steps.map((s) => s.text), ...local.questions.map((q) => q.text));
    }
  }
  const seen = new Set<string>();
  return out.filter(({ text, language }) => {
    const key = `${language}\u0000${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

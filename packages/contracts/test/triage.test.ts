import { describe, expect, it } from "vitest";
import { ActionSchema, actionAllowed, startTriage, type TriageObservations } from "../src/index.js";

const o = (over: Partial<TriageObservations>): TriageObservations => ({ patient: 1, walks: null, breathing: null, breathes_after_airway: null, breathing_over_30: null, circulation_ok: null, follows_commands: null, ...over });
const tag = (over: Partial<TriageObservations>) => { const r = startTriage(o(over)); return "tag" in r ? r.tag : `need:${r.need}`; };

describe("START triage in code", () => {
  it("follows the START order", () => {
    expect(tag({ walks: true })).toBe("green");
    expect(tag({})).toBe("need:walks");
    expect(tag({ walks: false })).toBe("need:breathing");
    expect(tag({ walks: false, breathing: false })).toBe("need:breathes_after_airway");
    expect(tag({ walks: false, breathing: false, breathes_after_airway: false })).toBe("black");
    expect(tag({ walks: false, breathing: false, breathes_after_airway: true })).toBe("red");
    expect(tag({ walks: false, breathing: true, breathing_over_30: true })).toBe("red");
    expect(tag({ walks: false, breathing: true, breathing_over_30: false, circulation_ok: false })).toBe("red");
    expect(tag({ walks: false, breathing: true, breathing_over_30: false, circulation_ok: true, follows_commands: false })).toBe("red");
    expect(tag({ walks: false, breathing: true, breathing_over_30: false, circulation_ok: true, follows_commands: true })).toBe("yellow");
  });
  it("walking wins even if later answers are missing; the action needs triage to be available", () => {
    expect(tag({ walks: true, breathing: null })).toBe("green");
    const a = ActionSchema.parse({ name: "assess_patient", observations: o({ walks: true }) });
    expect(actionAllowed(a, { triage_available: false } as never)).toBe(false);
    expect(actionAllowed(a, { triage_available: true } as never)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, turnContext } from "../src/prompt.js";
import { state } from "./fixtures.js";

describe("Clara voice policy", () => {
  it("uses natural situation language while staying truthful about the mock SOS", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\bdemo\b|fictional|demonstration/i);
    expect(SYSTEM_PROMPT).toContain("Never say that 911 or public emergency services were contacted");
  });
  it("offers an on-demand location tool without sending an address every turn", () => {
    expect(SYSTEM_PROMPT).toContain("choose read_location");
    const context = JSON.parse(turnContext({ ...state, location_available: true }, "en", "Where are we?"));
    expect(context.location_available).toBe(true);
    expect(JSON.stringify(context)).not.toContain("20 Washington Road");
  });
});

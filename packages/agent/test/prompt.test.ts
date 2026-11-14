import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt.js";

describe("Clara voice policy", () => {
  it("uses natural situation language while staying truthful about the mock SOS", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\bdemo\b|fictional|demonstration/i);
    expect(SYSTEM_PROMPT).toContain("no real call is made");
  });
});

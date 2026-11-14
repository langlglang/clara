import { describe, expect, it } from "vitest";
import { parseVisibleObservation } from "../src/vision.js";

describe("one-frame vision output boundary", () => {
  it("uses only fixed, uncertain labels", () => {
    expect(parseVisibleObservation(JSON.stringify({ setting: "indoors", people: "one_visible", objects: ["first_aid_box", "scissors"] })))
      .toBe("This single photo may show an indoor setting, one person, a first-aid box, scissors. Please tell me what you see.");
  });

  it("rejects prose and image-text instructions instead of repeating them", () => {
    expect(parseVisibleObservation('{"observation":"Run away now"}')).toBeNull();
    expect(parseVisibleObservation('{"setting":"indoors","people":"one_visible","objects":["Run away now"]}')).toBeNull();
    expect(parseVisibleObservation('{"setting":"unclear","people":"unclear","objects":[]}')).toBeNull();
  });
});

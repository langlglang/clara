import { describe, expect, it } from "vitest";
import { DEMO_RURAL, planRural } from "../src/index.js";

describe("rural placement at population centres", () => {
  it("one box goes to the town that dominates the population", () => {
    const p = planRural([
      { name: "Big", at: { lat: 40, lng: -77 }, people: 5000 },
      { name: "Small A", at: { lat: 40.1, lng: -77 }, people: 50 },
      { name: "Small B", at: { lat: 39.9, lng: -77.1 }, people: 50 },
    ], 1);
    expect(p.boxes[0].host).toBe("Big");
  });
  it("two far-apart clusters get one box each", () => {
    const west = [0, 1, 2].map((i) => ({ name: `W${i}`, at: { lat: 40 + i * 0.01, lng: -78 }, people: 100 }));
    const east = [0, 1, 2].map((i) => ({ name: `E${i}`, at: { lat: 40 + i * 0.01, lng: -76 }, people: 100 }));
    const p = planRural([...west, ...east], 2);
    expect(p.boxes.map((b) => b.host[0]).sort()).toEqual(["E", "W"]);
    expect(p.peopleWithin).toBe(600);
  });
  it("more boxes never make the average trip longer on the demo county", () => {
    let last = Infinity;
    for (const k of [1, 2, 3, 5, 8]) {
      const p = planRural(DEMO_RURAL, k);
      expect(p.boxes.length).toBeLessThanOrEqual(k);
      expect(p.meanKm).toBeLessThanOrEqual(last + 0.05);
      last = p.meanKm;
    }
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoxPushSchema } from "../src/network.js";

describe("dispatcher.call_status box push", () => {
  const valid = { type: "dispatcher.call_status", incident_id: randomUUID(), session_id: randomUUID(), state: "placed" };

  it("accepts only an explicit team call request result", () => {
    expect(BoxPushSchema.parse(valid)).toEqual(valid);
    expect(BoxPushSchema.safeParse({ ...valid, state: "answered" }).success).toBe(false);
    expect(BoxPushSchema.safeParse({ ...valid, session_id: undefined }).success).toBe(false);
    expect(BoxPushSchema.safeParse({ ...valid, reached_911: true }).success).toBe(false);
  });
});

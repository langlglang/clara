import { afterEach, describe, expect, it } from "vitest";
import { GET as getBriefing } from "../app/api/incidents/[id]/briefing/route";
import { GET as getAudio } from "../app/api/incidents/[id]/briefing/audio/route";

const previous = process.env.CLARA_ADMIN_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.CLARA_ADMIN_TOKEN;
  else process.env.CLARA_ADMIN_TOKEN = previous;
});

describe("call briefing access", () => {
  it("does not expose the latest incident or audio without the Admin credential", async () => {
    process.env.CLARA_ADMIN_TOKEN = "test-secret";
    const ctx = { params: Promise.resolve({ id: "latest" }) };
    for (const get of [getBriefing, getAudio]) {
      expect((await get(new Request("http://test/api/incidents/latest/briefing"), ctx)).status).toBe(403);
      expect((await get(new Request("http://test/api/incidents/latest/briefing", { headers: { "x-clara-admin-token": "wrong" } }), ctx)).status).toBe(403);
    }
  });
});

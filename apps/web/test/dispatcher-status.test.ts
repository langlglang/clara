import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoxPushSchema, EVENTS_VERSION } from "@clara/contracts";
import { createRuntime } from "../lib/server";

const twilioEnv = {
  CLARA_MODEL: "stub",
  CLARA_DEMO_911_NUMBER: "+17372583742",
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-token",
  TWILIO_FROM_NUMBER: "+15550000000",
};

describe("team dispatcher call status", () => {
  for (const [httpStatus, expected] of [[201, "placed"], [500, "failed"]] as const) {
    it(`pushes ${expected} only for the originating lid session`, async () => {
      const rt = createRuntime({ timers: false, env: twilioEnv,
        fetch: async () => new Response(JSON.stringify(httpStatus === 201 ? { sid: "CA123" } : { message: "unavailable" }), { status: httpStatus }) });
      try {
        const sessionId = randomUUID();
        const boxId = "box-clinic";
        const pushes: unknown[] = [];
        rt.subscribe((change) => {
          if (change.kind === "push" && change.box_id === boxId) pushes.push(change.push);
        });
        rt.network.ingest({ schema_version: EVENTS_VERSION, events: [
          { event_id: randomUUID(), box_id: boxId, session_id: sessionId, occurred_at: new Date().toISOString(), type: "sos.opened", need: "bleeding", source: "touch" },
        ] });
        const call = await rt.demo911.fire(boxId);
        const status = pushes.map((push) => BoxPushSchema.parse(push)).find((push) => push.type === "dispatcher.call_status");
        expect(status).toEqual({ type: "dispatcher.call_status", incident_id: call?.incident_id, session_id: sessionId, state: expected });
        expect(await rt.demo911.fire(boxId)).toBeNull();
      } finally {
        rt.stop();
      }
    });
  }
});

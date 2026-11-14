import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAMERA_INSPECT_VERSION, EVENTS_VERSION } from "@clara/contracts";
import { createRuntime, setRuntime, type Runtime } from "../lib/server";
import { POST } from "../app/api/boxes/[id]/camera/route";

const boxId = "box-clinic";
const params = { params: Promise.resolve({ id: boxId }) };
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(128, 0x20), Buffer.from([0xff, 0xd9])]).toString("base64");
let runtime: Runtime;
let sessionId: string;
let priorToken: string | undefined;
let priorModel: string | undefined;

function body(overrides: Record<string, unknown> = {}) {
  return { schema_version: CAMERA_INSPECT_VERSION, session_id: sessionId, task_id: randomUUID(), consent_id: randomUUID(),
    consent_scope: "capture_and_send_once", captured_at: new Date().toISOString(), image_base64: jpeg, ...overrides };
}
function post(payload: unknown, token = "secret") {
  return POST(new Request(`http://test/api/boxes/${boxId}/camera`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }), params);
}

beforeEach(() => {
  priorToken = process.env.CLARA_BOX_TOKEN;
  priorModel = process.env.ANTHROPIC_API_KEY;
  process.env.CLARA_BOX_TOKEN = "secret";
  delete process.env.ANTHROPIC_API_KEY;
  runtime = createRuntime({ timers: false, env: { CLARA_MODEL: "stub", CLARA_BOX_TOKEN: "secret" } });
  setRuntime(runtime);
  sessionId = randomUUID();
  runtime.network.ingest({ schema_version: EVENTS_VERSION, events: [{ event_id: randomUUID(), box_id: boxId, session_id: sessionId, occurred_at: new Date().toISOString(), type: "box.opened" }] });
});
afterEach(() => {
  setRuntime(null);
  if (priorToken === undefined) delete process.env.CLARA_BOX_TOKEN; else process.env.CLARA_BOX_TOKEN = priorToken;
  if (priorModel === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorModel;
});

describe("consented camera route", () => {
  it("requires the shared token and active matching session", async () => {
    expect((await post(body(), "wrong")).status).toBe(403);
    expect((await post(body({ session_id: randomUUID() }))).status).toBe(400);
    runtime.network.ingest({ schema_version: EVENTS_VERSION, events: [{ event_id: randomUUID(), box_id: boxId, session_id: sessionId, occurred_at: new Date().toISOString(), type: "box.closed" }] });
    expect((await post(body())).status).toBe(400);
  });

  it("rejects malformed, stale, and repeated frames; no model key returns unavailable", async () => {
    expect((await post(body({ image_base64: Buffer.alloc(130).toString("base64") }))).status).toBe(400);
    expect((await post(body({ captured_at: new Date(Date.now() - 60_000).toISOString() }))).status).toBe(400);
    const once = body();
    const response = await post(once);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task_id: once.task_id, status: "unavailable", observation: null });
    expect((await post(once)).status).toBe(409);
  });
});

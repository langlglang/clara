import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoxPushSchema } from "@clara/contracts";
import { reportShortCode, sequentialIds } from "@clara/network";
import { GET as boxStream } from "../app/api/boxes/[id]/stream/route";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { GET as shortLink } from "../app/r/[code]/route";
import { createRuntime, setRuntime, type Runtime } from "../lib/server";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
let rt: Runtime;
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  rt = createRuntime({ clock: () => new Date(T0), ids: sequentialIds(), timers: false, env: { CLARA_MODEL: "stub", PUBLIC_BASE_URL: "https://example.test/" } });
  setRuntime(rt);
});
afterEach(() => setRuntime(null));

async function openSos(box = "box-clinic") {
  const res = await demoSos(new Request(`http://test/api/demo/sos?box=${box}&need=bleeding`, { method: "POST" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { incident: { incident_id: string; report_token: string } }).incident;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  let text = "";
  while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
  return text;
}

describe("EMS report link", () => {
  it("pushes incident.opened with the report link to the box when its incident opens", async () => {
    const pushes: unknown[] = [];
    rt.network.subscribe((c) => {
      if (c.kind === "push" && c.box_id === "box-clinic") pushes.push(c.push);
    });
    const incident = await openSos();
    const code = reportShortCode(incident.report_token);
    const opened = pushes.map((p) => BoxPushSchema.parse(p)).find((p) => p.type === "incident.opened");
    expect(opened).toEqual({ type: "incident.opened", incident_id: incident.incident_id, report_url: `https://example.test/report/${incident.report_token}`, report_code: code });
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("replays incident.opened when the box stream reconnects while the incident is open", async () => {
    const incident = await openSos();
    const controller = new AbortController();
    const res = await boxStream(new Request("http://test/api/boxes/box-clinic/stream", { signal: controller.signal }), params({ id: "box-clinic" }));
    const reader = res.body!.getReader();
    const text = await readUntil(reader, "incident.opened");
    expect(text).toContain(`/report/${incident.report_token}`);
    controller.abort();
    await reader.cancel();
  });

  it("redirects the short route to the full report, and 404s an unknown code", async () => {
    const incident = await openSos();
    const code = reportShortCode(incident.report_token);
    const res = await shortLink(new Request(`http://test/r/${code}`), params({ code: code.toLowerCase() }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/report/${incident.report_token}`);
    const missing = await shortLink(new Request("http://test/r/ZZZZZZ"), params({ code: code === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ" }));
    expect(missing.status).toBe(404);
    expect((await shortLink(new Request("http://test/r/x"), params({ code: "../etc" }))).status).toBe(404);
  });
});

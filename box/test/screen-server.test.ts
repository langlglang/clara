import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SCREEN_VIEW_VERSION, contentPath, startScreenServer, type ScreenPress, type ScreenServer, type ScreenView } from "../src/screen/index.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
let server: ScreenServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const view = (revision: number): ScreenView => ({
  schema_version: SCREEN_VIEW_VERSION,
  revision,
  phase: "idle",
  lid_open: false,
  box_name: "Test",
  online: true,
  simulated: true,
  scenario_title: null,
  step: null,
  presentation: null,
  countdown: null,
  sos: null,
  coming: null,
  nearby: [],
  timers: [],
  multiple_injured: false,
  caption: null,
  notice: null,
  messages: [],
  pending_usage: null,
  voice_available: false,
  voice_state: "off",
  speech_muted: false,
  report_url: null,
  report_link: null,
  scenario_id: null,
  scenarios: [],
  coach: null,
  pulse_prompt: false,
});

/** Loopback only: the server under test. */
function call(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function start(onPress?: (p: ScreenPress) => void, contentDir: string | null = null) {
  server = await startScreenServer({ port: 0, publicDir, contentDir, current: () => view(1), token: "test-token", ...(onPress ? { onPress } : {}) });
  expect(server).not.toBeNull();
  return server!;
}

describe("screen server", () => {
  it("serves the page with the token and its assets", async () => {
    const s = await start();
    const page = await call(s.port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('content="test-token"');
    expect(page.body).toContain('data-action="sos"');
    expect(page.body).toContain('data-action="mute"');
    expect(page.body).toContain('id="sleep"');
    expect(page.body).not.toContain("CLARA DEMO");
    expect(page.body).not.toContain("EMERGENCY NEARBY");
    expect(page.body).not.toContain('id="box-name"');
    expect(page.body).toContain("911 GUIDE");
    for (const action of ["next", "back", "repeat", "talk", "goto", "start"]) {
      expect(page.body).not.toContain(`data-action="${action}"`);
    }
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect((await call(s.port, "/screen/assets/app.js")).status).toBe(200);
    expect((await call(s.port, "/screen/assets/style.css")).status).toBe(200);
    expect((await call(s.port, "/screen/assets/../main.ts")).status).toBe(404);
  });

  it("refuses a wrong Host or Origin", async () => {
    const s = await start();
    expect((await call(s.port, "/", { headers: { host: `evil.example:${s.port}` } })).status).toBe(421);
    expect((await call(s.port, "/", { headers: { origin: "http://evil.example" } })).status).toBe(421);
    expect((await call(s.port, "/", { headers: { host: `localhost:${s.port}` } })).status).toBe(200);
  });

  it("accepts a valid press with the token and refuses the rest", async () => {
    const presses: ScreenPress[] = [];
    const s = await start((p) => presses.push(p));
    const post = (body: unknown, token = "test-token") =>
      call(s.port, "/screen/press", { method: "POST", headers: { "content-type": "application/json", "x-screen-token": token }, body: JSON.stringify(body) });
    expect((await post({ action: "next" })).status).toBe(204);
    expect((await post({ action: "goto", step_id: "s2" })).status).toBe(204);
    expect((await post({ action: "mute" })).status).toBe(204);
    expect((await post({ action: "unmute" })).status).toBe(204);
    expect((await post({ action: "next" }, "wrong-token")).status).toBe(403);
    expect((await post({ action: "launch_missiles" })).status).toBe(400);
    expect((await post({ action: "next", extra: 1 })).status).toBe(400);
    expect(presses).toEqual([{ action: "next" }, { action: "goto", step_id: "s2" }, { action: "mute" }, { action: "unmute" }]);
  });

  it("streams the current view, then published views", async () => {
    const s = await start();
    expect((await call(s.port, "/screen/events?token=nope")).status).toBe(403);
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: s.port, path: "/screen/events?token=test-token", headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.on("data", (c: Buffer) => {
          chunks.push(c.toString());
          const all = chunks.join("");
          if (all.includes('"revision":1') && !all.includes('"revision":7')) s.publish(view(7));
          if (all.includes('"revision":7')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => (chunks.join("").includes('"revision":7') ? resolve() : reject(e)));
      req.end();
    });
    expect(chunks.join("")).toContain("event: view");
    expect(chunks.join("")).toContain('"schema_version":"screen-view/1.4"');
    expect(chunks.join("")).toContain('"speech_muted":false');
    expect(chunks.join("")).toContain('"presentation":null');
    expect(chunks.join("")).toContain('"step":null');
  });

  it("serves content images only, never outside content/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clara-content-"));
    dirs.push(dir);
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "images", "a.png"), "png");
    writeFileSync(join(dir, "secret.json"), "{}");
    const s = await start(undefined, dir);
    expect((await call(s.port, "/content/images/a.png")).status).toBe(200);
    expect((await call(s.port, "/content/secret.json")).status).toBe(404);
    expect((await call(s.port, "/content/..%2f..%2fetc%2fpasswd.png")).status).toBe(404);
    expect(contentPath(dir, "/../x.png")).toBeNull();
  });

  it("returns null when the port is taken", async () => {
    const s = await start();
    const second = await startScreenServer({ port: s.port, publicDir, current: () => null });
    expect(second).toBeNull();
  });
});

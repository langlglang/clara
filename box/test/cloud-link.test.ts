import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBatchSchema, VOICE_TURN_VERSION, type BoxEvent, type BoxPush, type TurnRequest } from "@clara/contracts";
import { CloudError, HttpCloudLink, Outbox, SseParser } from "../src/cloud/index.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "clara-cloud-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const event = (type: "box.opened" | "box.heartbeat" = "box.opened"): BoxEvent =>
  (type === "box.heartbeat"
    ? { event_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, box_id: "box-1", session_id: null, occurred_at: "2026-11-13T10:00:00.000Z", type, battery_pct: null, online_parts: [] }
    : { event_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, box_id: "box-1", session_id: null, occurred_at: "2026-11-13T10:00:00.000Z", type });

type Handler = (url: string, init: RequestInit) => Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const neverAnswers: Handler = (_url, init) =>
  new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));

describe("Outbox", () => {
  it("survives a restart and drops acked events", () => {
    const dir = tempDir();
    const a = new Outbox(dir);
    const e1 = event();
    const e2 = event();
    a.add(e1);
    a.add(e2);
    a.add(e1);
    expect(a.size).toBe(2);
    a.ack([e1.event_id]);
    const b = new Outbox(dir);
    expect(b.all().map((e) => e.event_id)).toEqual([e2.event_id]);
  });

  it("sets an unreadable file aside", () => {
    const dir = tempDir();
    new Outbox(dir).add(event());
    rmSync(join(dir, "outbox.json"));
    writeFileSync(join(dir, "outbox.json"), "{not json");
    expect(new Outbox(dir).size).toBe(0);
  });
});

describe("SseParser", () => {
  it("parses messages split across chunks and skips comments", () => {
    const parser = new SseParser();
    expect(parser.feed(": keepalive\n\nevent: push\ndata: {\"a\"")).toEqual([]);
    expect(parser.feed(":1}\r\n\r\ndata: x\n\n")).toEqual([
      { event: "push", data: '{"a":1}' },
      { event: "message", data: "x" },
    ]);
  });
});

describe("HttpCloudLink events", () => {
  it("posts queued events as an EventBatch and empties the outbox", async () => {
    const { impl, calls } = fakeFetch(async () => json({ ok: true }));
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", token: "t0k", stateDir: tempDir(), fetchImpl: impl, stream: false });
    link.start();
    link.record(event());
    link.record(event());
    await link.flush();
    expect(link.outbox.size).toBe(0);
    expect(link.online).toBe(true);
    const posted = calls.map((c) => EventBatchSchema.parse(JSON.parse(String(c.init.body))));
    expect(posted.flatMap((b) => b.events)).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://clara.example/api/boxes/box-1/events");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    link.close();
  });

  it("keeps events when the server is down, goes offline, and sends them later", async () => {
    let up = false;
    const { impl } = fakeFetch(async () => {
      if (!up) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    const dir = tempDir();
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: dir, fetchImpl: impl, stream: false, retry: { minMs: 10, maxMs: 20 } });
    const changes: boolean[] = [];
    link.onOnlineChange((o) => changes.push(o));
    link.start();
    link.record(event());
    await link.flush();
    expect(link.outbox.size).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "outbox.json"), "utf8"))).toHaveLength(1);
    up = true;
    await new Promise((r) => setTimeout(r, 50));
    await link.flush();
    expect(link.outbox.size).toBe(0);
    expect(changes).toEqual([true]);
    link.close();
  });

  it("times out a hung POST", async () => {
    const { impl } = fakeFetch(neverAnswers);
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, stream: false, deadlines: { postMs: 20 }, retry: { minMs: 10_000, maxMs: 10_000 } });
    link.start();
    link.record(event());
    await link.flush();
    expect(link.outbox.size).toBe(1);
    expect(link.online).toBe(false);
    link.close();
  });

  it("drops a batch the server refuses as invalid instead of wedging", async () => {
    const { impl } = fakeFetch(async () => json({ error: "bad" }, 400));
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, stream: false });
    link.start();
    link.record(event());
    await link.flush();
    expect(link.outbox.size).toBe(0);
    link.close();
  });
});

const request = (): TurnRequest => ({
  schema_version: VOICE_TURN_VERSION,
  client_turn_id: "00000000-0000-4000-8000-0000000000aa",
  session_id: "00000000-0000-4000-8000-0000000000bb",
  language: "en",
  input: { type: "text", text: "hello" },
  state: { scenario_id: "x", step_id: "s1", allowed_steps: [], questions: [], manifest: [], triage_available: false, recent_turns: [] },
});

describe("HttpCloudLink voice turns", () => {
  it("returns a valid response", async () => {
    const { impl, calls } = fakeFetch(async () =>
      json({ schema_version: VOICE_TURN_VERSION, client_turn_id: request().client_turn_id, heard: "hello", reply: "Hi", action: null, answered_by: "model", reason: null, speech: null }),
    );
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, stream: false });
    const response = await link.voiceTurn(request(), new AbortController().signal);
    expect(response.reply).toBe("Hi");
    expect(calls[0]?.url).toBe("https://clara.example/api/boxes/box-1/turns");
    link.close();
  });

  it("rejects a response for another turn", async () => {
    const { impl } = fakeFetch(async () =>
      json({ schema_version: VOICE_TURN_VERSION, client_turn_id: "00000000-0000-4000-8000-0000000000cc", heard: null, reply: "x", action: null, answered_by: "fixed", reason: "timeout", speech: null }),
    );
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, stream: false });
    await expect(link.voiceTurn(request(), new AbortController().signal)).rejects.toMatchObject({ kind: "bad_response" });
    link.close();
  });

  it("times out, and cancels on the caller's signal", async () => {
    const { impl } = fakeFetch(neverAnswers);
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, stream: false, deadlines: { turnMs: 20 } });
    await expect(link.voiceTurn(request(), new AbortController().signal)).rejects.toMatchObject({ kind: "timeout" });
    const controller = new AbortController();
    const turn = link.voiceTurn(request(), controller.signal);
    controller.abort();
    await expect(turn).rejects.toBeInstanceOf(CloudError);
    link.close();
  });
});

describe("HttpCloudLink push stream", () => {
  it("delivers valid pushes, ignores bad ones, and reconnects after the stream ends", async () => {
    const push: BoxPush = { type: "nearby.clear", incident_id: "i1" };
    let opens = 0;
    const { impl } = fakeFetch(async (url) => {
      if (!url.endsWith("/stream")) return json({ ok: true });
      opens += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(": hi\n\ndata: {\"type\":\"bogus\"}\n\n"));
          controller.enqueue(enc.encode(`event: push\ndata: ${JSON.stringify(push)}\n\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, retry: { minMs: 10, maxMs: 10 } });
    const got: BoxPush[] = [];
    link.onPush((p) => got.push(p));
    link.start();
    await new Promise((r) => setTimeout(r, 60));
    link.close();
    expect(got[0]).toEqual(push);
    expect(opens).toBeGreaterThan(1);
  });

  it("goes offline when the stream can't connect in time", async () => {
    const { impl } = fakeFetch(neverAnswers);
    const link = new HttpCloudLink({ serverUrl: "https://clara.example", boxId: "box-1", stateDir: tempDir(), fetchImpl: impl, deadlines: { connectMs: 10 }, retry: { minMs: 1_000, maxMs: 1_000 } });
    const changes: boolean[] = [];
    link.onOnlineChange((o) => changes.push(o));
    link.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(link.online).toBe(false);
    link.close();
  });
});

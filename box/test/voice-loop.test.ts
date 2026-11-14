import { describe, expect, it } from "vitest";
import { VOICE_TURN_VERSION, type Action, type TurnRequest, type TurnResponse, type TurnState } from "@clara/contracts";
import { createSpeechQueue } from "../src/audio/speech-queue.js";
import { wavFromPcm } from "../src/audio/wav.js";
import type { Clip, Listener } from "../src/ports.js";
import { createVoiceLoop, LOCAL_LINES, type VoiceLoopEvent } from "../src/voice/index.js";
import { FakeClock, FakeSpeaker, flush } from "./audio-fakes.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const state: TurnState = {
  scenario_id: "bleeding",
  step_id: "start",
  allowed_steps: [{ step_id: "pressure", label: "Apply pressure" }],
  questions: [],
  manifest: [{ sku: "gauze", name: "Gauze", on_hand: 4 }],
  triage_available: false,
  recent_turns: [],
};

class FakeListener implements Listener {
  calls: string[] = [];
  onClip: ((clip: Clip) => void) | null = null;
  onActivity: ((active: boolean) => void) | null = null;
  onAvailability: ((available: boolean) => void) | null = null;
  start(onClip: (clip: Clip) => void, onActivity?: (active: boolean) => void, onAvailability?: (available: boolean) => void) {
    this.onClip = onClip;
    this.onActivity = onActivity ?? null;
    this.onAvailability = onAvailability ?? null;
    this.calls.push("start");
  }
  pause() {
    this.calls.push("pause");
  }
  resume() {
    this.calls.push("resume");
  }
  stop() {
    this.calls.push("stop");
  }
  pressTalk() {
    this.calls.push("pressTalk");
  }
  endPress() {
    this.calls.push("endPress");
  }
  get last() {
    return this.calls.at(-1);
  }
  clip(ms = 800): Clip {
    const clip = { wav: wavFromPcm(Buffer.alloc(ms * 32, 3), 16_000), durationMs: ms };
    this.onClip?.(clip);
    return clip;
  }
  activity(active: boolean) { this.onActivity?.(active); }
  availability(available: boolean) { this.onAvailability?.(available); }
}

const answer = (action: Action | null, reply = "", speech = false): TurnResponse => ({
  schema_version: VOICE_TURN_VERSION,
  client_turn_id: TURN,
  heard: "it's bleeding",
  reply,
  action,
  answered_by: "model",
  reason: null,
  speech: speech ? { mime: "audio/wav", sample_rate: 16_000, data_base64: Buffer.from("server-voice").toString("base64") } : null,
});

function setup(
  voiceTurn: (request: TurnRequest, signal: AbortSignal) => Promise<TurnResponse>,
  context = true,
  onAction?: (action: Action, response: TurnResponse, queue: ReturnType<typeof createSpeechQueue>) => void,
) {
  const clock = new FakeClock();
  const speaker = new FakeSpeaker();
  speaker.auto = true;
  const queue = createSpeechQueue(speaker, { clock });
  const listener = new FakeListener();
  const requests: TurnRequest[] = [];
  const actions: Action[] = [];
  const events: VoiceLoopEvent[] = [];
  const loop = createVoiceLoop({
    listener,
    queue,
    clock,
    newId: () => TURN,
    getContext: () => (context ? { sessionId: SESSION, language: "en", state } : null),
    voiceTurn: (request, signal) => (requests.push(request), voiceTurn(request, signal)),
    onAction: (action, response) => {
      actions.push(action);
      onAction?.(action, response, queue);
    },
    playCue: (name) => speaker.playCue(name),
    onEvent: (event) => events.push(event),
  });
  return { clock, speaker, queue, listener, loop, requests, actions, events };
}

describe("voice loop", () => {
  it("reacts to live speech, processing, playback, and mic reconnection", async () => {
    const t = setup(() => new Promise<TurnResponse>(() => {}));
    t.loop.start();
    await flush();
    t.listener.activity(true);
    expect(t.loop.status).toBe("hearing");
    t.listener.clip();
    expect(t.loop.status).toBe("thinking");
    void t.queue.say({ text: "An approved panel" });
    expect(t.loop.status).toBe("speaking");
    t.loop.stop();
    expect(t.loop.status).toBe("off");

    const available = setup(async () => answer(null, "Okay."));
    available.loop.start();
    await flush();
    available.listener.availability(false);
    expect(available.loop.status).toBe("unavailable");
    available.listener.availability(true);
    expect(available.loop.status).toBe("listening");
  });

  it("starts paused, plays the listening cue, then opens the mic", async () => {
    const t = setup(async () => answer(null, "Okay."));
    t.loop.start();
    await flush();
    expect(t.listener.calls).toEqual(["start", "pause", "resume"]);
    expect(t.speaker.cues).toEqual(["listening"]);
    expect(t.loop.status).toBe("listening");
  });

  it("shows speaking for a greeting queued before the voice loop starts", async () => {
    const t = setup(async () => answer(null, "Okay."));
    t.speaker.auto = false;
    void t.queue.say({ text: "Greeting" });
    t.loop.start();
    expect(t.loop.status).toBe("speaking");
    expect(t.listener.last).toBe("pause");
    t.speaker.lines[0]!.finish();
    await flush();
    expect(t.loop.status).toBe("listening");
  });

  it("sends a clip as a TurnRequest, wipes it, and on select_step acts without speaking the reply", async () => {
    const t = setup(async () => answer({ name: "select_step", step_id: "pressure" }, "Press now."));
    t.loop.start();
    await flush();
    const clip = t.listener.clip(800);
    await flush();
    const request = t.requests[0]!;
    expect(request).toMatchObject({ schema_version: VOICE_TURN_VERSION, session_id: SESSION, language: "en", state });
    expect(request.input).toMatchObject({ type: "audio", mime: "audio/wav", duration_ms: 800 });
    expect(clip.wav.every((b) => b === 0)).toBe(true);
    expect(t.actions).toEqual([{ name: "select_step", step_id: "pressure" }]);
    expect(t.speaker.lines).toHaveLength(0);
    expect(t.speaker.cues).toEqual(["listening", "done", "listening"]);
    expect(t.listener.last).toBe("resume");
  });

  it("shows speaking while selected guidance plays during an active turn", async () => {
    const t = setup(
      async () => answer({ name: "select_step", step_id: "pressure" }, "Press now.", true),
      true,
      (_action, response, queue) => { void queue.say({ text: response.reply, wav: Buffer.from(response.speech!.data_base64, "base64") }); },
    );
    t.speaker.auto = false;
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    expect(t.loop.status).toBe("speaking");
    expect(t.speaker.lines.map((line) => `${line.kind}:${line.value}`)).toEqual(["wav:server-voice"]);
    expect(t.listener.last).toBe("pause");
    t.speaker.lines[0]!.finish();
    await flush();
    expect(t.loop.status).toBe("listening");
  });

  it("plays the server's WAV for a clarifying reply and keeps the mic paused until it ends", async () => {
    const t = setup(async () => answer({ name: "locate_item", sku: "gauze" }, "The gauze is lit.", true));
    t.speaker.auto = false;
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    expect(t.actions).toEqual([{ name: "locate_item", sku: "gauze" }]);
    expect(t.speaker.lines.map((l) => `${l.kind}:${l.value}`)).toEqual(["wav:server-voice"]);
    expect(t.listener.last).toBe("pause");
    expect(t.loop.status).toBe("speaking");
    t.speaker.lines[0]!.finish();
    await flush();
    expect(t.listener.last).toBe("resume");
  });

  it("silently resumes listening after the server rejects noise or filler", async () => {
    const t = setup(async () => ({
      ...answer(null), heard: null, reply: "", answered_by: "fixed", reason: "not_heard", speech: null,
    }));
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    expect(t.speaker.lines).toHaveLength(0);
    expect(t.actions).toHaveLength(0);
    expect(t.listener.last).toBe("resume");
    expect(t.loop.status).toBe("listening");
  });

  it("keeps the fallback for an empty model reply", async () => {
    const t = setup(async () => answer(null));
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    expect(t.speaker.lines.map((line) => line.value)).toEqual([LOCAL_LINES.notCaught]);
  });

  it("ignores an action that was not offered and speaks the reply with the local voice", async () => {
    const t = setup(async () => answer({ name: "select_step", step_id: "tourniquet" }, "Okay."));
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    expect(t.actions).toEqual([]);
    expect(t.events.some((e) => e.type === "ignored_action")).toBe(true);
    expect(t.speaker.lines.map((l) => `${l.kind}:${l.value}`)).toEqual(["speak:Okay."]);
  });

  it("says the timeout line at the deadline even if the cloud never answers", async () => {
    const t = setup(() => new Promise<TurnResponse>(() => {}));
    t.loop.start();
    await flush();
    t.listener.clip();
    await t.clock.advance(7_999);
    expect(t.speaker.lines).toHaveLength(0);
    await t.clock.advance(1);
    expect(t.speaker.lines.map((l) => l.value)).toEqual([LOCAL_LINES.timeout]);
    expect(t.events).toContainEqual({ type: "failed", reason: "timeout" });
    expect(t.listener.last).toBe("resume");
  });

  it("says the offline line when the link fails, and the unusable-reply line for a mismatched turn id", async () => {
    const offline = setup(async () => Promise.reject(new Error("no link")));
    offline.loop.start();
    await flush();
    offline.listener.clip();
    await flush();
    expect(offline.speaker.lines.map((l) => l.value)).toEqual([LOCAL_LINES.unreachable]);

    const wrong = setup(async () => ({ ...answer(null, "Hi"), client_turn_id: "33333333-3333-4333-8333-333333333333" }));
    wrong.loop.start();
    await flush();
    wrong.listener.clip();
    await flush();
    expect(wrong.speaker.lines.map((l) => l.value)).toEqual([LOCAL_LINES.notCaught]);
  });

  it("Talk cancels the turn in flight silently and starts a clip", async () => {
    let signal: AbortSignal | null = null;
    const t = setup((_, s) => ((signal = s), new Promise<TurnResponse>(() => {})));
    t.loop.start();
    await flush();
    t.listener.clip();
    await flush();
    t.loop.pressTalk();
    await t.clock.advance(10_000);
    expect(signal!.aborted).toBe(true);
    expect(t.speaker.lines).toHaveLength(0);
    expect(t.listener.calls).toContain("pressTalk");
  });

  it("drops clips with no active session or while the box is speaking", async () => {
    const none = setup(async () => answer(null, "x"), false);
    none.loop.start();
    await flush();
    none.listener.clip();
    await flush();
    expect(none.requests).toHaveLength(0);

    const t = setup(async () => answer(null, "x"));
    t.speaker.auto = false;
    t.loop.start();
    await flush();
    void t.queue.say({ text: "Step audio from a touch" });
    await flush();
    expect(t.listener.last).toBe("pause"); // half-duplex for lines queued elsewhere too
    t.listener.clip();
    await flush();
    expect(t.requests).toHaveLength(0);
  });

  it("sends typed text turns and stops cleanly", async () => {
    const t = setup(async () => answer(null, "Okay."));
    t.loop.start();
    await flush();
    await t.loop.sendText("  where is the gauze  ");
    expect(t.requests[0]!.input).toEqual({ type: "text", text: "where is the gauze" });
    t.loop.stop();
    expect(t.listener.last).toBe("stop");
    expect(t.loop.status).toBe("off");
  });
});

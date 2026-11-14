import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { actionAllowed, comingLine, type Action, type Alert, type BoxEvent, type BoxPush, type Scenario, type TurnResponse, type TurnState } from "@clara/contracts";
import { EventFactory, type EventBody } from "../engine/events.js";
import { ScenarioEngine, type RecentTurn, type Source, type StepIntent } from "../engine/engine.js";
import type { Kit } from "../engine/kit.js";
import type { LocationProvider } from "../location/gps.js";
import type { Board, CloudLink, CueName, SpeechQueue } from "../ports.js";
import { SCREEN_VIEW_VERSION, type ScreenPresentation, type ScreenPress, type ScreenView, type ScreenVoiceState } from "../screen/view.js";
import type { VoiceStatus } from "../voice/voice-loop.js";
import { systemClock, type Cancel, type Clock } from "./clock.js";
import { LINES, coachingLines } from "./lines.js";

const SCREEN_VOICE_STATES: Record<VoiceStatus, ScreenVoiceState> = {
  off: "starting",
  listening: "ready",
  hearing: "listening",
  thinking: "processing",
  speaking: "speaking",
  unavailable: "unavailable",
};

/**
 * The box's state machine:
 *
 *   idle ──lid opened──▶ listening ──spoken request──▶ guiding ──SOS──▶ countdown ──▶ sos
 *     ▲                                                                       │
 *     └────────────────────────────── lid closed ends the session ◀───────────┘
 *
 * It owns the scenario engine, carries out step intents (screen, speech, compartment lights), records every
 * box event to the cloud link's outbox, and turns server pushes into what the box shows and says. Who is
 * coming is said only through comingLine(); nothing here promises help.
 */

export type Need = "bleeding" | "breathing" | "general";

/** The parts of the hands-free voice loop the session drives (box/src/voice adapts to this). */
export interface VoiceControl {
  readonly handsFree?: boolean;
  start(): void;
  stop(): void;
  pressTalk(): void;
  endPress?(): void;
}

export interface BoxSessionOptions {
  boxId: string;
  boxName?: string;
  /** Written directions to this box, for the mock-911 coaching. */
  directions?: string | null;
  /** Site address shown as a fallback when USB GPS has no fresh fix. */
  configuredAddress?: string | null;
  location?: Pick<LocationProvider, "current"> | null;
  scenario: Scenario;
  kit: Kit;
  cloud: CloudLink;
  board?: Board | null;
  speech?: SpeechQueue | null;
  cue?: ((name: CueName) => void) | null;
  clock?: Clock;
  newId?: () => string;
  language?: string;
  /** Where step pictures and recorded audio live (the repo's content/). */
  contentDir?: string | null;
  fileExists?: (path: string) => boolean;
  /** What the mock SOS reports; by default guessed from the scenario id. */
  need?: Need;
  countdownSeconds?: number;
  simulated?: boolean;
  log?: (line: string) => void;
}

interface Countdown {
  total: number;
  endsAt: number;
  source: Source;
  cancelTick: Cancel;
}

const MAX_MESSAGES = 5;
const MAX_RECENT = 12;
const GREETING = "I'm Clara. I'm here to help. Tell me what happened, and I can guide you through first aid, help you find supplies, or open the SOS guide.";
const GREETING_AUDIO = "audio/clara-greeting-v2.wav";
const SLOT_IMAGES: Record<string, string> = {
  "top-left": "/content/kits/layout-3slot-v1-top-left.svg",
  "top-right": "/content/kits/layout-3slot-v1-top-right.svg",
  bottom: "/content/kits/layout-3slot-v1-bottom.svg",
};

export class BoxSession {
  readonly engine: ScenarioEngine;
  readonly events: EventFactory;
  readonly language: string;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;
  private readonly boxName: string;
  private readonly need: Need;
  private readonly countdownSeconds: number;

  private voice: VoiceControl | null = null;
  private voiceStatus: VoiceStatus = "off";
  private speechMuted = false;
  private lidOpen = false;
  private presentation: ScreenPresentation | null = null;
  private countdown: Countdown | null = null;
  private sos: { need: Need; openedAt: number; overlay: boolean } | null = null;
  private readonly alerts = new Map<string, Alert>();
  private lastComing: string | null = null;
  private readonly nearby = new Map<string, { incident_id: string; from_box_name: string; directions: string; bringing: boolean }>();
  private multipleInjured = false;
  private caption: string | null = null;
  private notice: string | null = null;
  private messages: { from: string; text: string; at: number }[] = [];
  private pendingUsage: { sku: string; name: string; qty: number }[] | null = null;
  private recent: RecentTurn[] = [];
  private lit: { sku: string; slot: string } | null = null;
  private lightEpoch = 0;
  private lightExpiryCancel: Cancel | null = null;
  private missing: { sku: string; name: string | null } | null = null;
  private online: boolean;
  private revision = 0;
  private reportUrl: string | null = null;
  private heartbeatCancel: Cancel | null = null;
  private readonly viewListeners = new Set<(view: ScreenView) => void>();
  private readonly eventListeners = new Set<(event: BoxEvent) => void>();

  constructor(private readonly o: BoxSessionOptions) {
    this.clock = o.clock ?? systemClock;
    this.newId = o.newId ?? randomUUID;
    this.log = o.log ?? (() => {});
    this.language = o.language ?? "en";
    this.boxName = o.boxName ?? o.boxId;
    this.countdownSeconds = o.countdownSeconds ?? 5;
    this.need = o.need ?? guessNeed(o.scenario.scenario_id);
    this.events = new EventFactory(o.boxId, () => this.clock.now(), this.newId, this.log);
    this.engine = new ScenarioEngine(o.scenario, o.kit, { events: this.events, emit: (e) => this.record(e), now: () => this.clock.now() });
    this.online = o.cloud.online;
    o.cloud.onPush((push) => this.onPush(push));
    o.cloud.onOnlineChange((online) => {
      this.online = online;
      this.publish();
    });
    o.board?.onEvent((event) => {
      if ("t" in event && event.t === "lid") {
        if (event.open) this.lidOpened();
        else this.lidClosed();
      }
    });
  }

  get sessionId(): string | null {
    return this.events.sessionId;
  }

  get active(): boolean {
    return this.events.sessionId !== null;
  }

  attachVoice(voice: VoiceControl | null): void {
    this.voice = voice;
    this.voiceStatus = "off";
    if (voice && this.lidOpen) voice.start();
    this.publish();
  }

  setVoiceStatus(status: VoiceStatus): void {
    if (!this.lidOpen || this.voiceStatus === status) return;
    this.voiceStatus = status;
    this.publish();
  }

  onView(listener: (view: ScreenView) => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  onEvent(listener: (event: BoxEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ---------- Lid ----------

  lidOpened(): void {
    if (this.lidOpen) return; // switch bounce or a repeated report
    this.lidOpen = true;
    if (!this.active) this.beginSession();
    this.board((b) => b.buzz("chime"));
    this.caption = GREETING;
    this.presentation = { kind: "answer", title: "Clara", body: GREETING, image_url: null, item: null, source_label: null };
    const audio = this.o.contentDir ? join(this.o.contentDir, GREETING_AUDIO) : null;
    if (audio && (this.o.fileExists ?? existsSync)(audio)) {
      // No local-voice fallback if the recorded greeting cannot play.
      this.o.speech?.say({ text: "", file: audio }).catch(() => {});
    }
    this.voice?.start();
    this.publish();
  }

  lidClosed(): void {
    if (!this.lidOpen) return;
    this.lidOpen = false;
    this.clearLightCue();
    this.voiceStatus = "off";
    if (!this.active) {
      this.publish();
      return;
    }
    if (this.countdown) {
      this.countdown.cancelTick();
      this.countdown = null;
      this.emit("sos.cancelled", { source: "device" });
    }
    this.emit("box.closed", {});
    this.voice?.stop();
    this.o.speech?.stopAll();
    this.board((b) => b.clearLights());
    this.engine.reset();
    this.events.sessionId = null;
    this.sos = null;
    this.alerts.clear();
    this.lastComing = null;
    this.multipleInjured = false;
    this.caption = null;
    this.presentation = null;
    this.notice = null;
    this.messages = [];
    this.pendingUsage = null;
    this.recent = [];
    this.missing = null;
    this.reportUrl = null;
    this.publish();
  }

  // ---------- Steps ----------

  start(source: Source = "touch"): void {
    this.ensureSession();
    this.apply(this.engine.start(source));
  }

  next(source: Source = "touch"): boolean {
    if (!this.engine.started) {
      this.start(source);
      return true;
    }
    const intents = this.engine.next(source);
    if (!intents) {
      this.say(LINES.endOfSteps);
      this.publish();
      return false;
    }
    this.apply(intents);
    return true;
  }

  back(source: Source = "touch"): boolean {
    const intents = this.engine.back(source);
    if (!intents) return false;
    this.apply(intents);
    return true;
  }

  repeat(): boolean {
    const intents = this.engine.repeat();
    if (!intents) return false;
    this.apply(intents);
    return true;
  }

  goTo(stepId: string, source: Source, wav?: Buffer): boolean {
    const intents = this.engine.goTo(stepId, source);
    if (!intents) return false;
    this.apply(intents, true, wav);
    return true;
  }

  // ---------- SOS ----------

  requestSos(source: Source): void {
    this.ensureSession();
    if (this.sos) {
      this.sos.overlay = true;
      this.publish();
      return;
    }
    if (this.countdown) return;
    const total = this.countdownSeconds;
    this.countdown = { total, endsAt: this.clock.monotonic() + total * 1000, source, cancelTick: () => {} };
    this.emit("sos.countdown", { seconds: total, source });
    // A step that opens SOS has just started speaking: the countdown line follows it instead of cutting it off.
    if (source !== "system") this.o.speech?.stopAll();
    this.say(LINES.countdown(total));
    this.scheduleTick();
    this.publish();
  }

  cancelSos(source: Source): boolean {
    if (!this.countdown) return false;
    this.countdown.cancelTick();
    this.countdown = null;
    this.emit("sos.cancelled", { source });
    this.o.speech?.stopAll();
    this.say(LINES.cancelled);
    this.publish();
    return true;
  }

  private scheduleTick(): void {
    const countdown = this.countdown;
    if (!countdown) return;
    const remaining = countdown.endsAt - this.clock.monotonic();
    const wait = remaining % 1000 || 1000;
    countdown.cancelTick = this.clock.setTimeout(() => {
      if (this.countdown !== countdown) return;
      if (countdown.endsAt - this.clock.monotonic() <= 0) this.openSos(countdown.source);
      else {
        this.scheduleTick();
        this.publish();
      }
    }, Math.min(wait, Math.max(0, remaining)));
  }

  private openSos(source: Source): void {
    this.countdown = null;
    this.sos = { need: this.need, openedAt: this.clock.now(), overlay: true };
    this.emit("sos.opened", { need: this.need, source });
    this.board((b) => b.buzz("alert"));
    this.o.cue?.("sos");
    this.o.speech?.stopAll();
    this.say(LINES.sosOpened);
    this.publish();
  }

  // ---------- Screen presses ----------

  press(press: ScreenPress): void {
    switch (press.action) {
      case "start":
        if (!this.engine.started) this.start("touch");
        return;
      case "next":
        this.next("touch");
        return;
      case "back":
        this.back("touch");
        return;
      case "repeat":
        this.repeat();
        return;
      case "goto":
        this.goTo(press.step_id, "touch");
        return;
      case "talk":
        if (!this.lidOpen) return;
        if (!this.voice) {
          this.say(LINES.noVoice);
          this.publish();
          return;
        }
        this.o.speech?.stopAll();
        this.voice.pressTalk();
        return;
      case "talk_end":
        if (!this.lidOpen) return;
        this.voice?.endPress?.();
        return;
      case "mute":
      case "unmute":
        this.speechMuted = press.action === "mute";
        this.o.speech?.setMuted(this.speechMuted);
        this.publish();
        return;
      case "sos":
        this.requestSos("touch");
        return;
      case "cancel_sos":
        this.cancelSos("touch");
        return;
      case "show_911":
      case "hide_911":
        if (this.sos) this.sos.overlay = press.action === "show_911";
        this.publish();
        return;
      case "multiple_injured":
        this.ensureSession();
        this.multipleInjured = true;
        this.notice = "Multiple injured noted. Tap SOS so the call says how many people are hurt.";
        this.publish();
        return;
      case "confirm_usage":
        this.confirmUsage();
        return;
      case "dismiss_usage":
        this.pendingUsage = null;
        this.publish();
        return;
      case "dismiss_notice":
        this.notice = null;
        this.publish();
        return;
      case "bringing_kit": {
        // Kept on this box only: the events contract has no "bringing this kit" event yet.
        const card = this.nearby.get(press.incident_id);
        if (card) card.bringing = true;
        this.publish();
        return;
      }
      case "dismiss_nearby":
        this.nearby.delete(press.incident_id);
        this.publish();
        return;
    }
  }

  // ---------- Voice ----------

  /** The state a voice turn offers the model, or null outside a session. */
  turnState(): TurnState | null {
    if (!this.active || !this.lidOpen) return null;
    return this.engine.turnState(this.recent);
  }

  remember(from: RecentTurn["from"], words: string): void {
    if (!words) return;
    this.recent.push({ from, words: words.slice(0, 1000) });
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
  }

  /** What the bystander said, as heard: recorded as a report, never as a fact. */
  heard(text: string): void {
    if (!this.active || !text.trim()) return;
    this.emit("report.heard", { text: text.slice(0, 1000) });
  }

  /**
   * Carries out a model action, only if `actionAllowed` against the box's own current state. Returns false
   * (and does nothing) otherwise.
   */
  applyAction(action: Action, source: Source = "voice", response?: TurnResponse): boolean {
    const state = this.turnState();
    if (!state || !actionAllowed(action, state)) {
      this.log(`action ${action.name} refused: not allowed in the current state`);
      return false;
    }
    switch (action.name) {
      case "select_step": {
        const step = this.engine.step(action.step_id);
        if (response && response.reply !== step.text) {
          this.log("selected guidance refused: cloud text differs from local content");
          this.say("I couldn't verify that guidance. Please tell me again.");
          return false;
        }
        const wav = response?.speech ? Buffer.from(response.speech.data_base64, "base64") : undefined;
        return this.goTo(action.step_id, source, wav);
      }
      case "ask_clarifying": {
        const question = this.o.scenario.questions.find((q) => q.question_id === action.question_id);
        this.notice = question?.text ?? null;
        if (question) {
          this.caption = question.text;
          this.presentation = { kind: "question", title: "Clara asks", body: question.text, image_url: null, item: null, source_label: null };
          this.o.speech?.say({ text: question.text }).catch(() => {});
        }
        this.publish();
        return true;
      }
      case "locate_item": {
        const item = this.o.kit.get(action.sku);
        this.presentation = item && item.on_hand > 0
          ? { kind: "item", title: item.name, body: `In the ${item.slot.replace("-", " ")} compartment.`,
              image_url: this.o.kit.layoutRevision === "3slot-v1" ? SLOT_IMAGES[item.slot] ?? null : null,
              item: { sku: item.sku, name: item.name, slot: item.slot, lit: false, missing: false }, source_label: "Kit inventory" }
          : { kind: "status", title: "Item unavailable", body: "This item is not listed as available in this box.", image_url: null, item: null, source_label: "Kit inventory" };
        this.apply(this.engine.locate(action.sku), false);
        return true;
      }
      case "record_usage":
        // Proposed only: the count changes after a tap on Confirm.
        this.pendingUsage = action.items.map((item) => ({ ...item, name: this.o.kit.get(item.sku)?.name ?? item.sku }));
        this.publish();
        return true;
      case "start_triage":
        this.multipleInjured = true;
        this.publish();
        return true;
      case "suggest_sos":
        this.requestSos(source);
        return true;
    }
  }

  /** Shows and says a line (a server reply, or a fixed line). */
  say(text: string, wav?: Buffer, showAsAnswer = true): void {
    this.caption = text;
    if (showAsAnswer && text.trim()) this.presentation = { kind: "answer", title: "Clara", body: text, image_url: null, item: null, source_label: null };
    this.o.speech?.say(wav ? { text, wav } : { text }).catch(() => {});
    this.publish();
  }

  /** Shows a line someone else is already speaking (the voice loop's reply), without saying it again. */
  showCaption(text: string, showAsAnswer = true): void {
    if (!this.lidOpen) return;
    this.caption = text;
    if (showAsAnswer && text.trim()) this.presentation = { kind: "answer", title: "Clara", body: text, image_url: null, item: null, source_label: null };
    this.publish();
  }

  /** The scene report link, when the server sends one. */
  setReportUrl(url: string | null): void {
    this.reportUrl = url;
    this.publish();
  }

  // ---------- Heartbeat ----------

  startHeartbeat(intervalMs: number, parts: () => string[]): void {
    this.heartbeatCancel?.();
    const beat = () => {
      this.emit("box.heartbeat", { battery_pct: null, online_parts: parts().slice(0, 20) });
      this.heartbeatCancel = this.clock.setTimeout(beat, intervalMs);
    };
    beat();
  }

  close(): void {
    this.heartbeatCancel?.();
    this.heartbeatCancel = null;
    this.countdown?.cancelTick();
    this.countdown = null;
    this.voice?.stop();
    this.o.speech?.stopAll();
    this.clearLightCue();
  }

  // ---------- Pushes ----------

  private onPush(push: BoxPush): void {
    switch (push.type) {
      case "alert.update": {
        if (!this.active) return;
        this.alerts.set(push.alert.alert_id, push.alert);
        const line = comingLine([...this.alerts.values()]);
        if (line !== this.lastComing) {
          if (line) {
            this.o.cue?.("alert");
            this.say(line);
          } else if (this.lastComing) this.say(LINES.helperWithdrew);
          this.lastComing = line;
        }
        this.publish();
        return;
      }
      case "responder.message": {
        if (!this.active) return;
        this.messages.push({ from: push.from, text: push.text, at: this.clock.now() });
        if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
        this.o.cue?.("alert");
        this.say(LINES.responderMessage(push.from, push.text));
        this.publish();
        return;
      }
      case "nearby.emergency": {
        if (push.from_box_id === this.o.boxId) return;
        const known = this.nearby.has(push.incident_id);
        this.nearby.set(push.incident_id, { incident_id: push.incident_id, from_box_name: push.from_box_name, directions: push.directions, bringing: known ? this.nearby.get(push.incident_id)!.bringing : false });
        this.publish();
        return;
      }
      case "nearby.clear":
        this.nearby.delete(push.incident_id);
        this.publish();
        return;
    }
  }

  // ---------- View ----------

  view(): ScreenView {
    const step = this.engine.current;
    const countdown = this.countdown;
    const voiceState: ScreenVoiceState = !this.lidOpen ? "off"
      : this.voice?.handsFree !== true ? "unavailable" : SCREEN_VOICE_STATES[this.voiceStatus];
    return {
      schema_version: SCREEN_VIEW_VERSION,
      revision: this.revision,
      phase: !this.active ? "idle" : countdown ? "countdown" : this.sos?.overlay ? "sos" : "guiding",
      lid_open: this.lidOpen,
      box_name: this.boxName,
      online: this.online,
      simulated: this.o.simulated ?? false,
      scenario_title: this.o.scenario.title,
      step: step
        ? {
            step_id: step.step_id,
            label: step.label,
            text: step.text,
            image_url: step.image ? `/content/${step.image.split("/").map(encodeURIComponent).join("/")}` : null,
            item: step.item
              ? {
                  sku: step.item,
                  name: this.o.kit.get(step.item)?.name ?? null,
                  slot: this.o.kit.get(step.item)?.slot ?? null,
                  lit: this.lit?.sku === step.item,
                  missing: this.missing?.sku === step.item,
                }
              : null,
            can_back: this.engine.canBack(),
            can_next: step.next.length > 0,
            options: step.next.length > 1 ? this.engine.allowedNext().map((s) => ({ step_id: s.step_id, label: s.label })) : [],
            is_end: step.next.length === 0,
          }
        : null,
      presentation: this.presentation
        ? { ...this.presentation, item: this.presentation.item
            ? { ...this.presentation.item, lit: this.lit?.sku === this.presentation.item.sku, missing: this.missing?.sku === this.presentation.item.sku }
            : null }
        : null,
      countdown: countdown ? { seconds_left: Math.max(0, Math.ceil((countdown.endsAt - this.clock.monotonic()) / 1000)), total: countdown.total } : null,
      sos: this.sos
        ? {
            need: this.sos.need,
            opened_at: this.sos.openedAt,
            overlay: this.sos.overlay,
            coaching: coachingLines({ directions: this.o.directions ?? null, multipleInjured: this.multipleInjured,
              location: this.o.location?.current() ?? null, configuredAddress: this.o.configuredAddress ?? null }),
          }
        : null,
      coming: this.lastComing,
      nearby: [...this.nearby.values()].map((n) => ({ ...n })),
      timers: this.engine.timersStarted().map((t) => ({ timer: t.timer, started_at: t.startedAt })),
      multiple_injured: this.multipleInjured,
      caption: this.caption,
      notice: this.notice,
      messages: this.messages.map((m) => ({ ...m })),
      pending_usage: this.pendingUsage ? this.pendingUsage.map((u) => ({ ...u })) : null,
      voice_available: this.lidOpen && this.voice?.handsFree === true,
      speech_muted: this.speechMuted,
      voice_state: voiceState,
      report_url: this.reportUrl,
    };
  }

  // ---------- Internals ----------

  private beginSession(): void {
    this.events.sessionId = this.newId();
    this.emit("box.opened", {});
  }

  private ensureSession(): void {
    if (!this.active) this.beginSession();
  }

  private apply(intents: StepIntent[], speakStep = true, wav?: Buffer): void {
    for (const intent of intents) {
      switch (intent.kind) {
        case "show":
          this.clearLightCue();
          if (!intent.step.item) this.board((b) => b.clearLights());
          this.missing = null;
          if (!intent.replay) this.notice = null;
          this.presentation = {
            kind: "guidance", title: intent.step.label, body: intent.step.text,
            image_url: intent.step.image ? `/content/${intent.step.image.split("/").map(encodeURIComponent).join("/")}`
              : this.o.kit.layoutRevision === "3slot-v1" && intent.step.item
                ? SLOT_IMAGES[this.o.kit.get(intent.step.item)?.slot ?? ""] ?? null : null,
            item: intent.step.item ? {
              sku: intent.step.item, name: this.o.kit.get(intent.step.item)?.name ?? null,
              slot: this.o.kit.get(intent.step.item)?.slot ?? null, lit: false, missing: false,
            } : null,
            source_label: null,
          };
          if (speakStep) this.speakStep(intent.step, wav);
          break;
        case "light":
          this.clearLightCue();
          this.missing = null;
          this.requestLight(intent);
          break;
        case "item_missing":
          this.missing = { sku: intent.sku, name: intent.name };
          this.notice = LINES.itemMissing(intent.name);
          this.o.speech?.say({ text: this.notice }).catch(() => {});
          break;
        case "clear_lights":
          this.clearLightCue();
          this.board((b) => b.clearLights());
          break;
        case "start_timer":
          break;
        case "open_sos_countdown":
          this.requestSos("system");
          break;
      }
    }
    this.publish();
  }

  private clearLightCue(): void {
    this.lightEpoch += 1;
    this.lightExpiryCancel?.();
    this.lightExpiryCancel = null;
    this.lit = null;
  }

  private requestLight(intent: Extract<StepIntent, { kind: "light" }>): void {
    const board = this.o.board;
    if (!board || !this.lidOpen) return;
    const epoch = this.lightEpoch;
    const leaseMs = Math.min(intent.ms, 30_000);
    const expiresAt = this.clock.monotonic() + leaseMs;
    let command: Promise<boolean>;
    try {
      command = board.lightCompartment(intent.channel, leaseMs, "solid");
    } catch (error) {
      this.log(`board: ${(error as Error)?.message ?? "failed"}`);
      return;
    }
    void command.then((ack) => {
      if (epoch !== this.lightEpoch || !this.lidOpen) return;
      const remaining = expiresAt - this.clock.monotonic();
      if (!ack || remaining <= 0) {
        if (!ack) this.log(`board: LED ${intent.channel} refused`);
        return;
      }
      this.lit = { sku: intent.sku, slot: intent.slot };
      this.lightExpiryCancel = this.clock.setTimeout(() => {
        if (epoch !== this.lightEpoch) return;
        this.lit = null;
        this.lightExpiryCancel = null;
        this.publish();
      }, remaining);
      this.publish();
    }).catch((error: unknown) => this.log(`board: ${(error as Error)?.message ?? "failed"}`));
  }

  private speakStep(step: { text: string; audio?: Record<string, string> | undefined }, wav?: Buffer): void {
    this.o.speech?.stopAll();
    this.caption = step.text;
    if (wav) {
      this.o.speech?.say({ text: step.text, wav }).catch(() => {});
      return;
    }
    const recorded = step.audio?.[this.language];
    const exists = this.o.fileExists ?? existsSync;
    const file = recorded && this.o.contentDir ? join(this.o.contentDir, recorded) : undefined;
    this.o.speech?.say(file && exists(file) ? { text: step.text, file } : { text: step.text }).catch(() => {});
  }

  private confirmUsage(): void {
    const usage = this.pendingUsage;
    this.pendingUsage = null;
    if (usage) {
      for (const item of usage) {
        if (this.o.kit.use(item.sku, item.qty)) this.emit("supply.used", { sku: item.sku, qty: item.qty, confirmed: true });
      }
      this.say(LINES.usageConfirmed);
    }
    this.publish();
  }

  private emit<T extends BoxEvent["type"]>(type: T, body: EventBody<T>): void {
    const event = this.events.make(type, body);
    if (event) this.record(event);
  }

  private record(event: BoxEvent): void {
    try {
      this.o.cloud.record(event);
    } catch (error) {
      this.log(`event ${event.type} not queued: ${(error as Error).message}`);
    }
    for (const listener of this.eventListeners) listener(event);
  }

  /** A board call never blocks or breaks the flow: a failure is logged and the screen keeps working. */
  private board(call: (board: Board) => Promise<unknown>): void {
    const board = this.o.board;
    if (!board) return;
    try {
      call(board).catch((error: unknown) => this.log(`board: ${(error as Error)?.message ?? "failed"}`));
    } catch (error) {
      this.log(`board: ${(error as Error)?.message ?? "failed"}`);
    }
  }

  private publish(): void {
    this.revision += 1;
    if (this.viewListeners.size === 0) return;
    const view = this.view();
    for (const listener of this.viewListeners) {
      try {
        listener(view);
      } catch (error) {
        this.log(`view listener failed: ${(error as Error).message}`);
      }
    }
  }
}

export function guessNeed(scenarioId: string): Need {
  if (/bleed/i.test(scenarioId)) return "bleeding";
  if (/breath|cpr|chok/i.test(scenarioId)) return "breathing";
  return "general";
}

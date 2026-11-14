import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { VISUALS, CAMERA_INSPECT_VERSION, VOICE_TURN_VERSION, actionAllowed, comingLine, guidedAdvanceAllowed, guidedStartAllowed, localizeScenario, minorCutVisualAllowed, startTriage, visualById, type Action, type Alert, type BoxEvent, type BoxPush, type Scenario, type ScenarioTranslation, type TurnResponse, type TurnState } from "@clara/contracts";
import { EventFactory, type EventBody } from "../engine/events.js";
import { ScenarioEngine, type RecentTurn, type Source, type StepIntent } from "../engine/engine.js";
import type { Kit } from "../engine/kit.js";
import type { LocationProvider } from "../location/gps.js";
import type { CameraCapture } from "../camera/capture.js";
import type { PulseReader, PulseObservation } from "../sensors/pulse-reader.js";
import type { Board, CloudLink, CueName, SpeechQueue, Utterance } from "../ports.js";
import { SCREEN_VIEW_VERSION, type ScreenPresentation, type ScreenPress, type ScreenView, type ScreenVoiceState } from "../screen/view.js";
import type { VoiceStatus } from "../voice/voice-loop.js";
import { systemClock, type Cancel, type Clock } from "./clock.js";
import { GREETINGS, coachingLines, linesFor } from "./lines.js";
import { RhythmCoach } from "./coach.js";
import { buildHandoffSummary } from "./summary.js";
import { CloudError } from "../cloud/http.js";

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
  /** Other scenarios the box may switch to (start-screen picker, or a bystander saying "not breathing"). */
  scenarios?: Scenario[];
  /** Scenario words in other languages (content/scenarios/<language>/). The bystander can switch on screen. */
  translations?: ScenarioTranslation[];
  /** Plays a generated WAV straight to the speaker: the CPR metronome tick. */
  tick?: ((wav: Buffer) => Utterance) | null;
  kit: Kit;
  cloud: CloudLink;
  board?: Board | null;
  pulseReader?: PulseReader | null;
  camera?: CameraCapture | null;
  cameraCloudEnabled?: boolean;
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
const EMERGENCY_QUESTION_TTL_MS = 120_000;
const EMERGENCY_PROMPTS = {
  situation: "Can you briefly tell me what happened?",
  people_count: "How many people need help?",
  location: "Where are you? I do not have a verified box address.",
} as const;
const GREETING_AUDIO = "audio/clara-greeting-v3-fast.wav";
const SLOT_IMAGES: Record<string, string> = {
  "top-left": "/content/kits/layout-3slot-v1-top-left.svg",
  "top-right": "/content/kits/layout-3slot-v1-top-right.svg",
  bottom: "/content/kits/layout-3slot-v1-bottom.svg",
};

export class BoxSession {
  /** The current scenario's engine; replaced when the box switches scenario (picker or "not breathing"). */
  engine: ScenarioEngine;
  readonly events: EventFactory;
  private lang: string;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;
  private readonly boxName: string;
  private readonly fixedNeed: Need | null;
  private readonly baseScenarios: Scenario[];
  private scenarios: Scenario[];
  private readonly coach: RhythmCoach;
  /** This lid session's own events, for the offline handoff summary. */
  private sessionEvents: BoxEvent[] = [];
  private report: { url: string; code: string } | null = null;
  /** The no-pulse prompt (a question to the bystander, never a decision). */
  private pulsePrompt = false;
  private pulsePromptAt: number | null = null;
  private fingerSeenAt: number | null = null;
  private validPulseSeen = false;
  private lastPulseRecord: { at: number; bpm: number | null; quality: string } | null = null;
  private readonly countdownSeconds: number;

  private voice: VoiceControl | null = null;
  private voiceStatus: VoiceStatus = "off";
  private speechMuted = false;
  private lidOpen = false;
  private presentation: ScreenPresentation | null = null;
  private countdown: Countdown | null = null;
  private sos: { need: Need; openedAt: number; overlay: boolean; nearbyAsked: boolean } | null = null;
  private emergencyTaskId: string | null = null;
  private readonly background = new Map<"pulse" | "camera", AbortController>();
  private latestPulse: PulseObservation | null = null;
  private completedTasks: { presentation: ScreenPresentation; wav?: Buffer }[] = [];
  private emergencyQuestion: { taskId: string; questionId: "situation" | "people_count" | "location"; prompt: string; wav: Buffer | null; expiresAt: number; prompted: boolean } | null = null;
  private emergencyQuestionExpiry: Cancel | null = null;
  private readonly heardByTurn = new Map<string, { eventId: string; sessionId: string; text: string }>();
  private readonly alerts = new Map<string, Alert>();
  private lastComing: string | null = null;
  private readonly nearby = new Map<string, { incident_id: string; from_box_name: string; directions: string; bringing: boolean }>();
  private multipleInjured = false;
  private caption: string | null = null;
  private notice: string | null = null;
  private messages: { from: string; text: string; at: number }[] = [];
  private pendingUsage: { sku: string; name: string; qty: number }[] | null = null;
  private recent: RecentTurn[] = [];
  private personTurnSequence = 0;
  private lit: { sku: string; slot: string } | null = null;
  private lightEpoch = 0;
  private lightExpiryCancel: Cancel | null = null;
  private missing: { sku: string; name: string | null } | null = null;
  private online: boolean;
  private revision = 0;

  private heartbeatCancel: Cancel | null = null;
  private readonly viewListeners = new Set<(view: ScreenView) => void>();
  private readonly eventListeners = new Set<(event: BoxEvent) => void>();

  constructor(private readonly o: BoxSessionOptions) {
    this.clock = o.clock ?? systemClock;
    this.newId = o.newId ?? randomUUID;
    this.log = o.log ?? (() => {});
    this.lang = o.language ?? "en";
    this.boxName = o.boxName ?? o.boxId;
    this.countdownSeconds = o.countdownSeconds ?? 5;
    this.fixedNeed = o.need ?? null;
    this.baseScenarios = [o.scenario, ...(o.scenarios ?? []).filter((s) => s.scenario_id !== o.scenario.scenario_id)];
    if (!this.languages().includes(this.lang)) this.lang = "en";
    this.scenarios = this.baseScenarios.map((s) => this.loc(s));
    this.coach = new RhythmCoach({ clock: this.clock, board: o.board ?? null, speech: o.speech ?? null, play: o.tick ?? null, log: this.log });
    this.events = new EventFactory(o.boxId, () => this.clock.now(), this.newId, this.log);
    this.engine = this.makeEngine(this.loc(o.scenario));
    this.online = o.cloud.online;
    o.speech?.onIdle(() => { this.presentEmergencyQuestion(); this.presentCompletedTask(); });
    o.cloud.onPush((push) => this.onPush(push));
    o.cloud.onOnlineChange((online) => {
      this.online = online;
      this.publish();
    });
    o.board?.onEvent((event) => {
      if ("t" in event && event.t === "lid") {
        if (event.open) this.lidOpened();
        else this.lidClosed();
      } else if ("t" in event && event.t === "sensor.raw") {
        if (event.ir !== null && event.ir >= FINGER_IR_MIN) this.fingerSeenAt = this.clock.monotonic();
      } else if ("t" in event && event.t === "pulse") this.onPulse(event.bpm, event.quality);
    });
  }

  /** The language the box speaks and shows now. */
  get language(): string {
    return this.lang;
  }

  /** English plus every language with at least one scenario translation. */
  languages(): string[] {
    return ["en", ...new Set((this.o.translations ?? []).map((t) => t.language))];
  }

  private get L() {
    return linesFor(this.lang);
  }

  private loc(scenario: Scenario): Scenario {
    if (this.lang === "en") return scenario;
    return localizeScenario(scenario, this.o.translations?.find((t) => t.scenario_id === scenario.scenario_id && t.language === this.lang));
  }

  /**
   * Switches the box's language: screen words, Clara's voice (speech-to-text, the model's replies, text-to-speech)
   * and fixed lines. The current step stays where it is and is shown and said again in the new language.
   */
  setLanguage(language: string): boolean {
    if (language === this.lang || !this.languages().includes(language)) return false;
    this.lang = language;
    this.scenarios = this.baseScenarios.map((s) => this.loc(s));
    const base = this.baseScenarios.find((s) => s.scenario_id === this.engine.scenario.scenario_id);
    if (base) this.engine.relabel(this.loc(base));
    this.recent = [];
    this.o.speech?.stopAll();
    this.log(`language: ${language}`);
    if (this.engine.current) this.repeat();
    else if (this.lidOpen) {
      const greeting = GREETINGS[this.lang] ?? GREETINGS.en!;
      this.caption = greeting;
      this.presentation = { kind: "answer", title: "Clara", body: greeting, image_url: null, item: null, source_label: null };
      this.o.speech?.say({ text: greeting }).catch(() => {});
    }
    this.publish();
    return true;
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
    if (status === "listening") { this.presentEmergencyQuestion(); this.presentCompletedTask(); }
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
    const greeting = GREETINGS[this.lang] ?? GREETINGS.en!;
    this.caption = greeting;
    this.presentation = { kind: "answer", title: "Clara", body: greeting, image_url: null, item: null, source_label: null };
    const audio = this.o.contentDir && this.lang === "en" ? join(this.o.contentDir, GREETING_AUDIO) : null;
    if (audio && (this.o.fileExists ?? existsSync)(audio)) {
      // No local-voice fallback if the recorded greeting cannot play.
      this.o.speech?.say({ text: "", file: audio }).catch(() => {});
    } else if (this.lang !== "en") this.o.speech?.say({ text: greeting }).catch(() => {});
    this.voice?.start();
    this.presentEmergencyQuestion();
    this.publish();
  }

  lidClosed(): void {
    if (!this.lidOpen) return;
    this.lidOpen = false;
    this.cancelBackground();
    if (this.sessionId) this.o.camera?.endSession(this.sessionId);
    this.latestPulse = null;
    for (const task of this.completedTasks) task.wav?.fill(0);
    this.completedTasks = [];
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
    this.clearEmergencyQuestion();
    this.emergencyTaskId = null;
    this.heardByTurn.clear();
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
    this.report = null;
    this.pulsePrompt = false;
    this.pulsePromptAt = null;
    this.fingerSeenAt = null;
    this.validPulseSeen = false;
    this.lastPulseRecord = null;
    this.coach.stop();
    this.sessionEvents = [];
    if (this.engine.scenario.scenario_id !== this.o.scenario.scenario_id) this.engine = this.makeEngine(this.loc(this.o.scenario));
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
      this.say(this.L.endOfSteps);
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
      return;
    }
    if (this.countdown) return;
    const total = this.countdownSeconds;
    this.countdown = { total, endsAt: this.clock.monotonic() + total * 1000, source, cancelTick: () => {} };
    this.emit("sos.countdown", { seconds: total, source });
    // A step that opens SOS has just started speaking: the countdown line follows it instead of cutting it off.
    if (source !== "system") this.o.speech?.stopAll();
    this.say(this.L.countdown(total), undefined, false);
    this.scheduleTick();
    this.publish();
  }

  cancelSos(source: Source): boolean {
    if (!this.countdown) return false;
    this.countdown.cancelTick();
    this.countdown = null;
    this.emit("sos.cancelled", { source });
    this.o.speech?.stopAll();
    this.say(this.L.cancelled);
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
    this.sos = { need: this.currentNeed(), openedAt: this.clock.now(), overlay: false, nearbyAsked: false };
    const opened = this.emit("sos.opened", { need: this.currentNeed(), source });
    this.emergencyTaskId = opened?.event_id ?? null;
    if (opened) {
      // Sent once, with the SOS, so the emergency call can say where the box is right away: a GPS fix from the last
      // few minutes when the receiver has one (with the configured address too), else the configured address.
      const address = this.o.configuredAddress?.trim();
      const known = address && address.length <= 200 ? address : null;
      const fix = this.o.location?.current() ?? null;
      const fresh = fix && this.clock.now() - fix.observedAt <= GPS_FRESH_MS;
      this.emit("emergency.context", {
        task_id: opened.event_id,
        location: fresh
          ? { kind: "gps_fix", latitude: Number(fix.latitude.toFixed(6)), longitude: Number(fix.longitude.toFixed(6)), observed_at: new Date(fix.observedAt).toISOString(), address: known }
          : known ? { kind: "configured_address", address: known } : { kind: "unavailable" },
      });
    }
    this.board((b) => b.buzz("alert"));
    this.o.cue?.("sos");
    this.o.speech?.stopAll();
    this.say(this.L.sosOpened, undefined, false);
    this.publish();
  }

  /**
   * The person at this box, in SOS, asked other Clara boxes nearby to bring their kits. Never sent by default:
   * only this request lets the network (or its coordinator) send for another box's kit.
   */
  askNearby(source: Source): boolean {
    if (!this.sos || this.sos.nearbyAsked) return false;
    this.sos.nearbyAsked = true;
    this.emit("nearby.requested", { source });
    this.say(this.online ? this.L.nearbyAsked : this.L.nearbyAskedOffline);
    this.publish();
    return true;
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
          this.say(this.L.noVoice);
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
      case "ask_nearby":
        this.askNearby("touch");
        return;
      case "show_911":
      case "hide_911":
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
      case "pulse_not_breathing":
      case "pulse_breathing":
        this.answerPulsePrompt(press.action === "pulse_breathing", "touch");
        return;
      case "stop_coach":
        this.coach.stop();
        this.publish();
        return;
      case "read_summary":
        if (!this.active) return;
        this.readSummary();
        return;
      case "set_language":
        this.setLanguage(press.language);
        return;
      case "pick_scenario":
        this.switchScenario(press.scenario_id, "touch");
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
    const guides = this.scenarios.flatMap((scenario) => {
      if (!scenario.guided || scenario.scenario_id === this.engine.scenario.scenario_id) return [];
      const first = scenario.steps.find((step) => step.step_id === scenario.start);
      if (!first || (first.item && (this.o.kit.get(first.item)?.on_hand ?? 0) <= 0)) return [];
      return [{ scenario_id: scenario.scenario_id, label: scenario.title, start_step_id: scenario.start }];
    });
    const state = { ...this.engine.turnState(this.recent),
      guided_active: this.engine.scenario.guided === true && this.engine.started,
      guided_scenarios: this.lang === "en" && !this.sos ? guides.slice(0, 12) : [],
      pulse_available: Boolean(this.o.pulseReader),
      ...(this.sos && !this.sos.nearbyAsked ? { nearby_kits_available: true as const } : {}),
      camera_available: Boolean(this.o.camera && this.o.cloud.inspectCamera && this.o.cameraCloudEnabled),
      // Visual captions are English and checked word for word, so other languages don't offer them yet.
      available_visuals: this.lang !== "en" ? [] : VISUALS.filter((visual) => {
      if (visual.id === "kit_overview" && this.o.kit.layoutRevision !== "3slot-v1") return false;
      if (visual.sku && (this.o.kit.get(visual.sku)?.on_hand ?? 0) <= 0) return false;
      const file = this.o.contentDir && join(this.o.contentDir, visual.image_url.slice("/content/".length));
      return Boolean(file && (this.o.fileExists ?? existsSync)(file));
    }).map((visual) => ({ visual_id: visual.id, label: visual.title })) };
    const question = this.emergencyQuestion;
    if (question && this.clock.monotonic() < question.expiresAt) {
      return { ...state, pending_emergency_question: { task_id: question.taskId, question_id: question.questionId, prompt: question.prompt } };
    }
    return state;
  }

  remember(from: RecentTurn["from"], words: string): void {
    if (!words) return;
    if (from === "person") this.personTurnSequence++;
    this.recent.push({ from, words: words.slice(0, 1000) });
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
  }

  /** What the bystander said, as heard: recorded as a report, never as a fact. */
  heard(text: string, clientTurnId?: string): void {
    if (!this.active || !text.trim()) return;
    const words = text.slice(0, 1000);
    const event = this.emit("report.heard", { text: words });
    if (event && clientTurnId && this.sessionId) {
      this.heardByTurn.set(clientTurnId, { eventId: event.event_id, sessionId: this.sessionId, text: words });
      if (this.heardByTurn.size > MAX_RECENT) this.heardByTurn.delete(this.heardByTurn.keys().next().value!);
    }
    if (this.pulsePrompt) {
      if (NOT_BREATHING.test(text)) return void this.answerPulsePrompt(false, "voice");
      if (BREATHING_YES.test(text)) return void this.answerPulsePrompt(true, "voice");
    }
    // A fixed keyword rule, not the model: "not breathing" switches to the CPR scenario when the box has it.
    const cpr = this.scenarios.find((s) => /breath|cpr/i.test(s.scenario_id));
    if (cpr && cpr.scenario_id !== this.engine.scenario.scenario_id && NOT_BREATHING.test(text)) this.switchScenario(cpr.scenario_id, "voice");
  }

  private sameHeardReport(response: TurnResponse): boolean {
    const report = this.heardByTurn.get(response.client_turn_id);
    return Boolean(report && response.answered_by === "model" && report.sessionId === this.sessionId && report.text === response.heard);
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
        if (state.guided_active && action.step_id !== state.step_id && (!response ||
          !guidedAdvanceAllowed(response.heard ?? "") || !this.sameHeardReport(response))) return false;
        if (response && response.reply !== step.text) {
          this.log("selected guidance refused: cloud text differs from local content");
          this.say("I couldn't verify that guidance. Please tell me again.");
          return false;
        }
        const wav = response?.speech ? Buffer.from(response.speech.data_base64, "base64") : undefined;
        return this.goTo(action.step_id, source, wav);
      }
      case "start_guidance": {
        const guide = this.scenarios.find((scenario) => scenario.scenario_id === action.scenario_id);
        const first = guide?.steps.find((step) => step.step_id === guide.start);
        if (!guide || !first || !response || !guidedStartAllowed(response.heard ?? "") ||
          (guide.scenario_id === "minor_cut" && !minorCutVisualAllowed(response.heard ?? "")) ||
          !this.sameHeardReport(response) || response.reply !== first.text) return false;
        const wav = response.speech ? Buffer.from(response.speech.data_base64, "base64") : undefined;
        return this.switchScenario(action.scenario_id, source, wav);
      }
      case "ask_clarifying": {
        const question = this.engine.scenario.questions.find((q) => q.question_id === action.question_id);
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
      case "show_visual": {
        const visual = visualById(action.visual_id);
        if (!visual || (response && response.reply !== visual.line)) return false;
        if (visual.id === "minor_cut_rinse_cover" && (!response?.heard || !minorCutVisualAllowed(response.heard))) return false;
        if (this.sos) this.sos.overlay = false;
        this.clearLightCue();
        this.board((board) => board.clearLights());
        this.presentation = { kind: "diagram", title: visual.title, body: visual.line, image_url: visual.image_url,
          item: null, source_label: "Illustration" };
        this.publish();
        return true;
      }
      case "read_pulse":
        if (!this.o.pulseReader || !this.sessionId) return false;
        this.startPulseTask(this.sessionId);
        return true;
      case "request_camera": {
        const report = response ? this.heardByTurn.get(response.client_turn_id) : null;
        if (!this.o.camera || !this.sessionId || !report || report.sessionId !== this.sessionId || !response ||
          response.heard !== report.text || !this.o.camera.grantFromRequest(this.sessionId, report.text)) return false;
        this.heardByTurn.delete(response.client_turn_id);
        this.startCameraTask(this.sessionId, report.text);
        return true;
      }
      case "capture_camera":
        return false; // Retained in the wire union for old clients, but never offered in the current voice turn.
      case "record_usage":
        // Proposed only: the count changes after a tap on Confirm.
        this.pendingUsage = action.items.map((item) => ({ ...item, name: this.o.kit.get(item.sku)?.name ?? item.sku }));
        this.publish();
        return true;
      case "start_triage":
        this.multipleInjured = true;
        this.publish();
        return true;
      case "assess_patient": {
        // The model only reported observations; fixed START rules decide the tag.
        this.multipleInjured = true;
        const r = startTriage(action.observations);
        if ("tag" in r) this.emit("triage.tagged", { patient: action.observations.patient, tag: r.tag });
        this.publish();
        return true;
      }
      case "suggest_sos":
        this.requestSos(source);
        return true;
      case "request_nearby_kits":
        return this.askNearby(source);
      case "answer_emergency_question": {
        const question = this.emergencyQuestion;
        const report = response ? this.heardByTurn.get(response.client_turn_id) : null;
        if (!this.sos || !question || !response || !report || !this.sessionId ||
          question.taskId !== action.task_id || question.questionId !== action.question_id ||
          this.clock.monotonic() >= question.expiresAt || report.sessionId !== this.sessionId ||
          response.answered_by !== "model" || !response.heard?.trim() || response.heard.length > 500 || response.heard !== report.text) return false;
        this.emit("emergency.answer", {
          task_id: question.taskId, question_id: question.questionId,
          answer: report.text, source_event_id: report.eventId,
        });
        this.heardByTurn.delete(response.client_turn_id);
        this.clearEmergencyQuestion();
        return true;
      }
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
    if (this.sos && showAsAnswer) this.sos.overlay = false;
    this.caption = text;
    if (showAsAnswer && text.trim()) this.presentation = { kind: "answer", title: "Clara", body: text, image_url: null, item: null, source_label: null };
    this.publish();
  }

  /** The scene report link, when the server sends one. */
  setReportUrl(url: string | null, code?: string): void {
    this.report = url ? { url, code: code ?? "" } : null;
    this.publish();
  }

  /**
   * The handoff summary from this session's own events (fixed templates, no model, no network): shown on the
   * handoff card and spoken through the speech queue.
   */
  readSummary(): string[] {
    const summary = buildHandoffSummary(this.sessionEvents, {
      stepLabel: (scenarioId, stepId) => this.scenarios.find((s) => s.scenario_id === scenarioId)?.steps.find((s) => s.step_id === stepId)?.label ?? null,
    });
    this.presentation = { kind: "handoff", title: "Handoff summary", body: summary.lines.join("\n"), image_url: null, item: null, source_label: "From this box's own record" };
    this.caption = null;
    this.o.speech?.stopAll();
    this.o.speech?.say({ text: summary.speech }).catch(() => {});
    this.publish();
    return summary.lines;
  }

  /** Switches to another loaded scenario and starts it at its first step. False when unknown or already current. */
  switchScenario(scenarioId: string, source: Source, wav?: Buffer): boolean {
    const next = this.scenarios.find((s) => s.scenario_id === scenarioId);
    if (!next) return false;
    this.ensureSession();
    if (next.scenario_id !== this.engine.scenario.scenario_id) {
      this.coach.stop();
      this.engine = this.makeEngine(next);
    } else if (this.engine.started) return false;
    this.log(`scenario: ${next.scenario_id} (${source})`);
    this.apply(this.engine.start(source), true, wav);
    return true;
  }

  /**
   * A pulse reading from the board. It is recorded as a device reading. A reading with no usable pulse while the finger
   * clip is in use only asks the bystander (prompt + fixed line); it never starts compressions or picks a step.
   */
  private onPulse(rawBpm: number | null, quality: "valid" | "suspect" | "unavailable"): void {
    if (!this.active) return;
    const bpm = rawBpm !== null && rawBpm >= 20 ? rawBpm : null;
    const now = this.clock.monotonic();
    const last = this.lastPulseRecord;
    if (!last || last.bpm !== bpm || last.quality !== quality || now - last.at >= PULSE_RECORD_EVERY_MS) {
      this.lastPulseRecord = { at: now, bpm, quality };
      this.emit("sensor.pulse", { bpm, quality });
    }
    if (quality === "valid" && bpm !== null) {
      this.validPulseSeen = true;
      return;
    }
    if (bpm !== null || quality === "suspect") return;
    // "Clip in use": a finger seen on the raw sensor in the last few seconds, or a valid reading earlier this session.
    const clipInUse = this.validPulseSeen || (this.fingerSeenAt !== null && now - this.fingerSeenAt <= FINGER_RECENT_MS);
    if (!clipInUse || this.pulsePrompt || this.coach.active) return;
    if (this.pulsePromptAt !== null && now - this.pulsePromptAt < PULSE_REPROMPT_MS) return;
    this.pulsePrompt = true;
    this.pulsePromptAt = now;
    this.o.cue?.("alert");
    this.say(this.L.noPulse);
  }

  /** The bystander's answer to the no-pulse prompt: NOT BREATHING goes straight to the CPR coach step and SOS. */
  answerPulsePrompt(breathing: boolean, source: Source): void {
    if (!this.pulsePrompt) return;
    this.pulsePrompt = false;
    if (breathing) {
      this.publish();
      return;
    }
    this.startCpr(source);
  }

  /** Jumps to the CPR scenario's first coached step and opens the SOS countdown if it is not open. */
  startCpr(source: Source): boolean {
    const cpr = this.scenarios.find((s) => s.steps.some((st) => st.coach));
    const step = cpr?.steps.find((st) => st.coach);
    if (!cpr || !step) return false;
    this.ensureSession();
    if (!this.sos && !this.countdown) this.requestSos(source);
    if (cpr.scenario_id !== this.engine.scenario.scenario_id) {
      this.coach.stop();
      this.engine = this.makeEngine(cpr);
    }
    if (this.engine.current?.coach) return true;
    this.apply(this.engine.startAt(step.step_id, source));
    return true;
  }

  private makeEngine(scenario: Scenario): ScenarioEngine {
    return new ScenarioEngine(scenario, this.o.kit, { events: this.events, emit: (e) => this.record(e), now: () => this.clock.now() });
  }

  private currentNeed(): Need {
    return this.fixedNeed ?? guessNeed(this.engine.scenario.scenario_id);
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
    this.cancelBackground();
    if (this.sessionId) this.o.camera?.endSession(this.sessionId);
    for (const task of this.completedTasks) task.wav?.fill(0);
    this.completedTasks = [];
    this.heartbeatCancel?.();
    this.heartbeatCancel = null;
    this.countdown?.cancelTick();
    this.countdown = null;
    this.voice?.stop();
    this.coach.stop();
    this.o.speech?.stopAll();
    this.clearLightCue();
    this.clearEmergencyQuestion();
    this.heardByTurn.clear();
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
          } else if (this.lastComing) this.say(this.L.helperWithdrew);
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
        this.say(this.L.responderMessage(push.from, push.text));
        this.publish();
        return;
      }
      case "nearby.emergency": {
        if (push.from_box_id === this.o.boxId) return;
        const known = this.nearby.has(push.incident_id);
        this.nearby.set(push.incident_id, { incident_id: push.incident_id, from_box_name: push.from_box_name, directions: push.directions, bringing: known ? this.nearby.get(push.incident_id)!.bringing : false });
        if (!known && !this.active) {
          // Said even with the lid closed, so someone near this box hears it. A box helping its own patient isn't
          // interrupted: the card waits on its screen.
          this.o.cue?.("alert");
          this.o.speech?.say({ text: this.L.nearbyEmergency(push.from_box_name, push.directions) }).catch(() => {});
        }
        this.publish();
        return;
      }
      case "nearby.clear":
        this.nearby.delete(push.incident_id);
        this.publish();
        return;
      case "emergency.question": {
        if (!this.sos || push.session_id !== this.sessionId || push.task_id !== this.emergencyTaskId) return;
        const previous = this.emergencyQuestion;
        if (previous?.taskId === push.task_id && previous.questionId === push.question_id) return;
        this.clearEmergencyQuestion();
        const expiresAt = this.clock.monotonic() + EMERGENCY_QUESTION_TTL_MS;
        // The push is transport data, not an instruction to Clara. Render only our fixed question text.
        const prompt = EMERGENCY_PROMPTS[push.question_id];
        const encoded = push.prompt === prompt ? push.speech?.data_base64 : undefined;
        const wav = encoded && encoded.length <= 1_500_000 ? Buffer.from(encoded, "base64") : null;
        this.emergencyQuestion = { taskId: push.task_id, questionId: push.question_id,
          prompt, wav: wav && wav.length <= 1_000_000 && wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE" ? wav : null,
          expiresAt, prompted: false };
        this.emergencyQuestionExpiry = this.clock.setTimeout(() => {
          if (this.emergencyQuestion?.taskId !== push.task_id || this.emergencyQuestion?.questionId !== push.question_id) return;
          this.clearEmergencyQuestion();
          this.publish();
        }, EMERGENCY_QUESTION_TTL_MS);
        this.presentEmergencyQuestion();
        this.publish();
        return;
      }
      case "emergency.status":
        if (push.session_id !== this.sessionId || push.task_id !== this.emergencyTaskId) return;
        if (push.state === "facts_ready" || push.state === "cancelled") this.clearEmergencyQuestion();
        if (push.state === "cancelled") this.emergencyTaskId = null;
        this.publish();
        return;
      case "dispatcher.call_status":
        if (!this.sos || push.session_id !== this.sessionId) return;
        this.say(push.state === "placed" ? this.L.callPlaced : this.L.callFailed, undefined, false);
        return;
      case "incident.opened":
        if (!this.active) return;
        this.setReportUrl(push.report_url, push.report_code);
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
      phase: !this.active ? "idle" : "guiding",
      lid_open: this.lidOpen,
      box_name: this.boxName,
      online: this.online,
      simulated: this.o.simulated ?? false,
      scenario_title: this.engine.scenario.title,
      step: step
        ? {
            step_id: step.step_id,
            label: step.label,
            text: step.text,
            image_url: step.image ? `/content/${step.image.split("/").map(encodeURIComponent).join("/")}` : null,
            video_url: step.video ? contentUrl(step.video) : null,
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
            nearby_asked: this.sos.nearbyAsked,
            coaching: coachingLines({ directions: this.o.directions ?? null, multipleInjured: this.multipleInjured,
              location: this.o.location?.current() ?? null, configuredAddress: this.o.configuredAddress ?? null, language: this.lang }),
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
      report_url: this.report?.url ?? null,
      report_link: this.report ? shortLink(this.report.url, this.report.code) : null,
      scenario_id: this.engine.scenario.scenario_id,
      scenarios: this.scenarios.map((s) => ({ scenario_id: s.scenario_id, title: s.title })),
      pulse_prompt: this.pulsePrompt,
      language: this.lang,
      languages: this.languages(),
      coach: this.coach.active ? { kind: "cpr", bpm: this.coach.active.bpm, started_at: this.coach.active.started_at } : null,
    };
  }

  // ---------- Internals ----------

  private beginSession(): void {
    this.sessionEvents = [];
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
          if (this.sos) this.sos.overlay = false;
          this.clearLightCue();
          if (!intent.step.item) this.board((b) => b.clearLights());
          this.missing = null;
          if (!intent.replay) this.notice = null;
          this.presentation = {
            kind: "guidance", title: intent.step.label, body: intent.step.text,
            video_url: intent.step.video ? contentUrl(intent.step.video) : null,
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
          if (intent.step.coach?.kind === "cpr") this.coach.start(intent.step.step_id, intent.step.coach.bpm);
          else this.coach.stop();
          break;
        case "light":
          this.clearLightCue();
          this.missing = null;
          this.requestLight(intent);
          break;
        case "item_missing":
          this.missing = { sku: intent.sku, name: intent.name };
          this.notice = this.L.itemMissing(intent.name);
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
      this.say(this.L.usageConfirmed);
    }
    this.publish();
  }

  private cancelBackground(): void {
    for (const controller of this.background.values()) controller.abort();
    this.background.clear();
  }

  private startPulseTask(sessionId: string): void {
    const reader = this.o.pulseReader;
    if (!reader) return;
    this.background.get("pulse")?.abort();
    const controller = new AbortController();
    this.background.set("pulse", controller);
    if (this.sos) this.sos.overlay = false;
    this.presentation = { kind: "status", title: "Reading pulse", body: "Keep a finger steady on the sensor. Clara is still listening.", image_url: null, item: null, source_label: "MAX30102 via ESP32" };
    this.publish();
    void reader.read(controller.signal).then((reading) => {
      if (controller.signal.aborted || !this.lidOpen || this.sessionId !== sessionId) return;
      this.latestPulse = reading?.quality === "valid" && reading.bpm !== null ? reading : null;
      const text = this.latestPulse
        ? `The MAX30102 returned ${this.latestPulse.bpm} beats per minute at ${this.latestPulse.observedAt}.`
        : reading?.quality === "suspect"
          ? "The sensor detected a signal but could not get a stable pulse estimate. Hold your finger steady and try again."
          : reading?.quality === "unavailable"
            ? "The sensor did not detect enough signal. Check finger placement and try again."
            : "The pulse sensor could not be read. Please try again.";
      this.queueCompletedTask({ kind: "reading", title: "Pulse sensor", body: text, image_url: null, item: null, source_label: "MAX30102 via ESP32" });
    }).catch(() => {
      if (this.lidOpen && this.sessionId === sessionId) this.queueCompletedTask({ kind: "status", title: "Pulse unavailable", body: "The pulse sensor could not be read.", image_url: null, item: null, source_label: "MAX30102 via ESP32" });
    }).finally(() => { if (this.background.get("pulse") === controller) this.background.delete("pulse"); });
  }

  private startCameraTask(sessionId: string, originalQuestion: string): void {
    const camera = this.o.camera;
    const inspect = this.o.cloud.inspectCamera;
    if (!camera || !inspect) return;
    this.background.get("camera")?.abort();
    const controller = new AbortController();
    this.background.set("camera", controller);
    const personTurns = this.personTurnSequence;
    if (this.sos) this.sos.overlay = false;
    this.presentation = { kind: "status", title: "Inspecting photo", body: "Clara is checking one consented camera frame. You can keep talking.", image_url: null, item: null, source_label: "USB camera" };
    this.publish();
    void (async () => {
      const frame = await camera.captureOnce(sessionId, "cloud_interpretation", controller.signal);
      if (!frame) { this.log("camera: capture unavailable"); return null; }
      try {
        return await inspect.call(this.o.cloud, {
          schema_version: CAMERA_INSPECT_VERSION,
          session_id: sessionId,
          task_id: this.newId(),
          consent_id: frame.consentId,
          consent_scope: "capture_and_send_once",
          captured_at: frame.capturedAt,
          image_base64: frame.jpeg.toString("base64"),
        }, controller.signal);
      } finally {
        frame.jpeg.fill(0);
      }
    })().then(async (result) => {
      if (controller.signal.aborted || !this.lidOpen || this.sessionId !== sessionId) return;
      this.log(`camera: cloud status ${result?.status ?? "not_sent"}`);
      if (!result) {
        this.queueCompletedTask({ kind: "status", title: "Camera unavailable", body: "I couldn't capture a photo. Please check the camera and try again.", image_url: null, item: null, source_label: "USB camera" });
        return;
      }
      if (result.status !== "observed" || !result.observation) {
        this.queueCompletedTask({ kind: "status", title: "Camera unavailable", body: "I couldn't analyze that photo. Please tell me what you see.", image_url: null, item: null, source_label: "USB camera" });
        return;
      }
      // A newer person turn takes priority; the image stays in short-lived Core context for their next question.
      if (this.personTurnSequence !== personTurns) return;
      const state = this.turnState();
      if (!state) return;
      let reply: TurnResponse;
      try {
        reply = await this.o.cloud.voiceTurn({
          schema_version: VOICE_TURN_VERSION, client_turn_id: this.newId(), session_id: sessionId,
          language: this.lang, input: { type: "text", text: originalQuestion.slice(0, 500) },
          state: { ...state, camera_available: false, camera_answer_pending: true },
        }, controller.signal);
      } catch {
        if (!controller.signal.aborted && this.sessionId === sessionId && this.personTurnSequence === personTurns) {
          this.queueCompletedTask({ kind: "status", title: "Camera review", body: "I reviewed the photo, but couldn't answer from it. Tell me what you'd like to know.",
            image_url: null, item: null, source_label: `Single frame captured ${result.captured_at}` });
        }
        return;
      }
      if (controller.signal.aborted || !this.lidOpen || this.sessionId !== sessionId ||
        this.personTurnSequence !== personTurns) return;
      const text = reply.action === null && reply.answered_by === "model" && reply.reply
        ? reply.reply : "I reviewed the photo, but couldn't answer from it. Tell me what you'd like to know.";
      this.remember("clara", text);
      this.queueCompletedTask({ kind: "answer", title: "Camera review", body: text, image_url: null, item: null,
        source_label: `Single frame captured ${result.captured_at}` }, reply.action === null && reply.answered_by === "model" && reply.reply && reply.speech
        ? Buffer.from(reply.speech.data_base64, "base64") : undefined);
    }).catch((error: unknown) => {
      this.log(`camera: cloud request failed (${error instanceof CloudError ? error.kind : "unknown"})`);
      if (this.lidOpen && this.sessionId === sessionId) this.queueCompletedTask({ kind: "status", title: "Camera unavailable", body: "I couldn't inspect that photo. Please describe what you see.", image_url: null, item: null, source_label: "USB camera" });
    }).finally(() => { if (this.background.get("camera") === controller) this.background.delete("camera"); });
  }

  private queueCompletedTask(presentation: ScreenPresentation, wav?: Buffer): void {
    this.completedTasks.push({ presentation, ...(wav ? { wav } : {}) });
    for (const dropped of this.completedTasks.slice(0, -2)) dropped.wav?.fill(0);
    this.completedTasks = this.completedTasks.slice(-2);
    this.presentCompletedTask();
  }

  private presentCompletedTask(): void {
    if (!this.lidOpen || this.completedTasks.length === 0 || this.o.speech?.busy ||
      ["hearing", "thinking", "speaking"].includes(this.voiceStatus)) return;
    const next = this.completedTasks.shift()!;
    this.presentation = next.presentation;
    this.caption = next.presentation.body;
    this.publish();
    if (this.o.speech && !this.o.speech.muted) void this.o.speech.say({ text: next.presentation.body, ...(next.wav ? { wav: next.wav } : {}) }).catch(() => {});
    else if (this.completedTasks.length) queueMicrotask(() => this.presentCompletedTask());
  }

  private clearEmergencyQuestion(): void {
    const question = this.emergencyQuestion;
    this.emergencyQuestionExpiry?.();
    this.emergencyQuestionExpiry = null;
    this.emergencyQuestion = null;
    if (question && this.presentation?.kind === "question" && this.presentation.body === question.prompt) this.presentation = null;
    if (question && this.caption === question.prompt) this.caption = null;
  }

  private presentEmergencyQuestion(): void {
    const question = this.emergencyQuestion;
    if (!question || question.prompted || !this.lidOpen || this.clock.monotonic() >= question.expiresAt ||
      this.o.speech?.busy || ["hearing", "thinking", "speaking"].includes(this.voiceStatus)) return;
    question.prompted = true;
    if (this.sos) this.sos.overlay = false;
    this.caption = question.prompt;
    this.presentation = { kind: "question", title: "Clara asks", body: question.prompt, image_url: null, item: null, source_label: null };
    // The existing Clara speech queue serializes this prompt with the main conversation.
    this.o.speech?.say(question.wav ? { text: question.prompt, wav: question.wav } : { text: question.prompt }).catch(() => {});
    this.publish();
  }

  private emit<T extends BoxEvent["type"]>(type: T, body: EventBody<T>): BoxEvent | null {
    const event = this.events.make(type, body);
    if (event) this.record(event);
    return event;
  }

  private record(event: BoxEvent): void {
    if (event.session_id !== null && event.session_id === this.events.sessionId && this.sessionEvents.length < 500) this.sessionEvents.push(event);
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

/** Raw IR at or above this means a finger is on the clip (MAX30102 ambient readings sit far below). Bench-check. */
/** A GPS fix older than this isn't sent with an SOS. */
const GPS_FRESH_MS = 5 * 60_000;
const FINGER_IR_MIN = 50_000;
const FINGER_RECENT_MS = 5_000;
const PULSE_REPROMPT_MS = 60_000;
const PULSE_RECORD_EVERY_MS = 10_000;
/** Checked only after NOT_BREATHING fails, and only while the no-pulse prompt is open. */
const BREATHING_YES = /\b(?:yes|breathing|sí|si|respira)\b/i;
const NOT_BREATHING = /\b(?:not|isn'?t|no|stopped|can'?t (?:see|hear|feel) (?:him |her |them )?)\s*breath|\bcpr\b|\bno (?:respira|está respirando)|dej[óo] de respirar|\brcp\b/i;

/** A content file's URL on the screen server ("/content/videos/cpr.webm"). */
function contentUrl(path: string): string {
  return `/content/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** "clara.living/r/AB12CD": the short report link as shown on screen (no scheme), or the full link without a code. */
export function shortLink(url: string, code: string): string {
  try {
    const u = new URL(url);
    return code ? `${u.host}/r/${code}` : `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export function guessNeed(scenarioId: string): Need {
  if (/bleed/i.test(scenarioId)) return "bleeding";
  if (/breath|cpr|chok/i.test(scenarioId)) return "breathing";
  return "general";
}

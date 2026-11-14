// Adapted from the pre-event Clara scaffold (Clara/box/src/scenario.ts): the box, not the model, owns the
// current step; the model only chooses among the steps this engine offers.
import type { BoxEvent, BoxEventType, Scenario, ScenarioStep, TurnState } from "@clara/contracts";
import type { EventBody, EventFactory } from "./events.js";
import type { Kit } from "./kit.js";

export type Source = "touch" | "voice" | "device" | "system";
export type TimerName = NonNullable<ScenarioStep["timer"]>;
export type RecentTurn = TurnState["recent_turns"][number];

/**
 * What showing a step asks the rest of the box to do. The engine never touches hardware or audio itself;
 * the session carries these out.
 */
export type StepIntent =
  | { kind: "show"; step: ScenarioStep; replay: boolean }
  /** Light the compartment holding `sku` (the kit manifest's LED channel). */
  | { kind: "light"; sku: string; slot: string; channel: number; ms: number }
  /** The step names an item the manifest doesn't have, or has none of: say so, light nothing. */
  | { kind: "item_missing"; sku: string; name: string | null }
  | { kind: "clear_lights" }
  | { kind: "start_timer"; timer: TimerName; startedAt: number }
  | { kind: "open_sos_countdown" };

export interface EngineOptions {
  events: EventFactory;
  emit: (event: BoxEvent) => void;
  now?: () => number;
  /** How long one light command lasts (the installed firmware caps it at 30 s; repeat relights it). */
  lightMs?: number;
}

const MAX_RECENT = 12;

export class ScenarioEngine {
  private currentId: string | null = null;
  private history: string[] = [];
  private readonly timers = new Map<TimerName, number>();
  private byId: Map<string, ScenarioStep>;
  private current_scenario: Scenario;
  private readonly now: () => number;
  private readonly lightMs: number;

  constructor(
    scenario: Scenario,
    readonly kit: Kit,
    private readonly o: EngineOptions,
  ) {
    this.current_scenario = scenario;
    this.byId = new Map(scenario.steps.map((step) => [step.step_id, step]));
    this.now = o.now ?? Date.now;
    this.lightMs = Math.min(30_000, Math.max(0, o.lightMs ?? 30_000));
  }

  get scenario(): Scenario {
    return this.current_scenario;
  }

  /**
   * Swaps in the same scenario in another language. Only words differ (localizeScenario), so the current step,
   * history and timers stay. Throws if the steps don't match.
   */
  relabel(scenario: Scenario): void {
    const same = scenario.scenario_id === this.current_scenario.scenario_id && scenario.steps.length === this.byId.size &&
      scenario.steps.every((s) => this.byId.get(s.step_id)?.next.join() === s.next.join());
    if (!same) throw new Error(`relabel: ${scenario.scenario_id} doesn't match the running scenario`);
    this.current_scenario = scenario;
    this.byId = new Map(scenario.steps.map((step) => [step.step_id, step]));
  }

  get started(): boolean {
    return this.currentId !== null;
  }

  get current(): ScenarioStep | null {
    return this.currentId === null ? null : this.step(this.currentId);
  }

  step(id: string): ScenarioStep {
    const step = this.byId.get(id);
    if (!step) throw new Error(`unknown step ${id}`);
    return step;
  }

  /** Starts (or restarts) the scenario at its first step. */
  start(source: Source): StepIntent[] {
    this.history = [];
    this.timers.clear();
    this.currentId = null;
    this.emit("scenario.started", { scenario_id: this.scenario.scenario_id, source });
    return this.enter(this.scenario.start, source);
  }

  /**
   * Starts the scenario directly at one of its steps (the bystander answered NOT BREATHING to the no-pulse prompt).
   */
  startAt(stepId: string, source: Source): StepIntent[] {
    this.step(stepId);
    this.history = [];
    this.timers.clear();
    this.currentId = null;
    this.emit("scenario.started", { scenario_id: this.scenario.scenario_id, source });
    return this.enter(stepId, source);
  }

  /** The default next step (the first of `next`). Null at the end of the scenario or before it started. */
  next(source: Source): StepIntent[] | null {
    const current = this.current;
    if (!current || current.next.length === 0) return null;
    return this.advance(current.next[0]!, source);
  }

  /** The step shown before this one. Null at the first step. */
  back(source: Source): StepIntent[] | null {
    if (!this.started || this.history.length === 0) return null;
    const previous = this.history.pop()!;
    return this.enter(previous, source);
  }

  /** Shows the current step again: picture, words, light. Timers and SOS are not triggered twice. */
  repeat(): StepIntent[] | null {
    const current = this.current;
    if (!current) return null;
    return [{ kind: "show", step: current, replay: true }, ...this.lightFor(current)];
  }

  /** Goes to a step only when it is allowed now (one of the current step's `next`, or the current one). */
  goTo(stepId: string, source: Source): StepIntent[] | null {
    const current = this.current;
    if (!current) return stepId === this.scenario.start ? this.start(source) : null;
    if (stepId === current.step_id) return this.repeat();
    if (!current.next.includes(stepId)) return null;
    return this.advance(stepId, source);
  }

  /** The steps the bystander or the model may go to next. */
  allowedNext(): ScenarioStep[] {
    const current = this.current;
    return current ? current.next.map((id) => this.step(id)) : [];
  }

  /** What the model may pick: the next steps, plus the current one so "say that again" works. */
  allowedSteps(): ScenarioStep[] {
    const current = this.current;
    const candidates = current ? [current, ...this.allowedNext()] : [this.step(this.scenario.start)];
    // Do not offer a panel that tells someone to retrieve equipment this physical box lacks.
    return candidates.filter((step) => !step.item || (this.kit.get(step.item)?.on_hand ?? 0) > 0);
  }

  canBack(): boolean {
    return this.started && this.history.length > 0;
  }

  /** The kit item lit for a `locate_item`, or `item_missing`. */
  locate(sku: string): StepIntent[] {
    return this.lightForSku(sku);
  }

  /** Timers started this session, with when (wall time, ms). */
  timersStarted(): { timer: TimerName; startedAt: number }[] {
    return [...this.timers].map(([timer, startedAt]) => ({ timer, startedAt }));
  }

  turnState(recent: readonly RecentTurn[] = []): TurnState {
    const current = this.current;
    return {
      scenario_id: this.scenario.scenario_id,
      step_id: current?.step_id ?? null,
      allowed_steps: this.allowedSteps().slice(0, 20).map((s) => ({ step_id: s.step_id, label: s.label })),
      questions: this.scenario.questions.slice(0, 20).map((q) => ({ question_id: q.question_id, text: q.text })),
      manifest: this.kit.manifest().slice(0, 40),
      triage_available: this.scenario.triage_available,
      recent_turns: recent.slice(-MAX_RECENT).map((t) => ({ from: t.from, words: t.words.slice(0, 1000) })),
    };
  }

  /** Back to not started (lid closed). */
  reset(): void {
    this.currentId = null;
    this.history = [];
    this.timers.clear();
  }

  private advance(stepId: string, source: Source): StepIntent[] {
    const current = this.current!;
    this.emit("step.done", { scenario_id: this.scenario.scenario_id, step_id: current.step_id, source });
    this.history.push(current.step_id);
    return this.enter(stepId, source);
  }

  private enter(stepId: string, source: Source): StepIntent[] {
    const step = this.step(stepId);
    this.currentId = step.step_id;
    this.emit("step.shown", { scenario_id: this.scenario.scenario_id, step_id: step.step_id, source });
    const intents: StepIntent[] = [{ kind: "show", step, replay: false }, ...this.lightFor(step)];
    if (step.timer && !this.timers.has(step.timer)) {
      const startedAt = this.now();
      this.timers.set(step.timer, startedAt);
      this.emit("timer.started", { timer: step.timer, step_id: step.step_id });
      intents.push({ kind: "start_timer", timer: step.timer, startedAt });
    }
    if (step.sos) intents.push({ kind: "open_sos_countdown" });
    return intents;
  }

  private lightFor(step: ScenarioStep): StepIntent[] {
    return step.item ? this.lightForSku(step.item) : [{ kind: "clear_lights" }];
  }

  private lightForSku(sku: string): StepIntent[] {
    const item = this.kit.get(sku);
    if (!item || item.on_hand === 0) return [{ kind: "clear_lights" }, { kind: "item_missing", sku, name: item?.name ?? null }];
    return [{ kind: "light", sku, slot: item.slot, channel: item.led, ms: this.lightMs }];
  }

  private emit<T extends BoxEventType>(type: T, body: EventBody<T>): void {
    const event = this.o.events.make(type, body);
    if (event) this.o.emit(event);
  }
}

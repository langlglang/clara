import { BoxPushSchema, type BoxEvent, type BoxPush, type EmergencyLocation, type EmergencyQuestionId } from "@clara/contracts";
import type { Network } from "@clara/network";
import { z } from "zod";

/** Collects reported facts for the simulated 911 screen. It never dials, messages, or speaks. */
export const CONTEXT_WAIT_MS = 2_000;
// The Pi SSE parser accepts at most 256 KiB per message, including JSON framing.
const MAX_PUSH_SPEECH_CHARS = 180_000;
const PROMPTS: Record<EmergencyQuestionId, string> = {
  situation: "Can you briefly tell me what happened?",
  people_count: "How many people need help?",
  location: "Where are you? I do not have a verified box address.",
};

/** Reject obvious mismatches even if a model selects the pending question ID by mistake. */
function fitsQuestion(question: EmergencyQuestionId, answer: string): boolean {
  const words = answer.trim().toLowerCase();
  if (!words || words.endsWith("?")) return false;
  if (question === "people_count") return /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|single|just me|only me|myself|a person)\b/.test(words);
  if (question === "location") return /\b(?:at|near|by|on|inside|outside)\s+\S+|\b(?:street|avenue|road|building|room|floor|entrance|address|park|school)\b/.test(words);
  return words.length >= 4;
}

interface Task {
  incident_id: string;
  box_id: string;
  session_id: string;
  task_id: string;
  pending: EmergencyQuestionId | null;
  ready: boolean;
  cancelled: boolean;
  waited: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  speechAbort: AbortController | null;
  delivered: BoxPush | null;
  answered: Set<EmergencyQuestionId>;
  usedReports: Set<string>;
}

export interface EmergencyWorker {
  pendingForBox(boxId: string): BoxPush | null;
  /** A source-labeled, bounded view for tests/maintainer tools; no free-text health report. */
  state(incidentId: string): { task_id: string; pending: EmergencyQuestionId | null; ready: boolean; cancelled: boolean; location: EmergencyLocation } | null;
  exportState(): unknown;
  stop(): void;
}

const SavedSchema = z.array(z.strictObject({ incident_id: z.string().min(1), task_id: z.uuid(), waited: z.boolean(), answered: z.array(z.enum(["situation", "people_count", "location"])), used_reports: z.array(z.uuid()).max(3) })).max(500);

export function createEmergencyWorker(o: { network: Network; emit: (change: { kind: "push"; box_id: string; push: BoxPush }) => void; contextWaitMs?: number; restored?: unknown; speak?: (prompt: string, signal: AbortSignal) => Promise<{ mime: "audio/wav"; sample_rate: number; data_base64: string } | null> }): EmergencyWorker {
  const tasks = new Map<string, Task>();
  const saved = new Map((SavedSchema.safeParse(o.restored).data ?? []).map((item) => [item.incident_id, item]));
  let stopped = false;
  const send = (task: Task, push: BoxPush) => {
    if (!stopped) o.emit({ kind: "push", box_id: task.box_id, push: BoxPushSchema.parse(push) });
  };
  const events = (task: Task) => o.network.store.eventsForBox(task.box_id).map((row) => row.event).filter((e) => e.session_id === task.session_id);
  const location = (task: Task): EmergencyLocation => {
    const context = events(task).find((e) => e.type === "emergency.context" && e.task_id === task.task_id);
    return context?.type === "emergency.context" ? context.location : { kind: "unavailable" };
  };
  const hasContext = (task: Task) => events(task).some((e) => e.type === "emergency.context" && e.task_id === task.task_id);
  const validAnswer = (task: Task, e: BoxEvent): e is Extract<BoxEvent, { type: "emergency.answer" }> => {
    if (e.type !== "emergency.answer" || e.task_id !== task.task_id || !fitsQuestion(e.question_id, e.answer)) return false;
    const report = o.network.store.eventsForBox(task.box_id).find((row) => row.event.event_id === e.source_event_id);
    const rows = o.network.store.eventsForBox(task.box_id);
    const sosSeq = rows.find((row) => row.event.event_id === task.task_id)?.seq ?? 0;
    const answerSeq = rows.find((row) => row.event.event_id === e.event_id)?.seq ?? 0;
    return report?.event.type === "report.heard" && report.event.session_id === task.session_id && report.event.text === e.answer && report.seq > sosSeq && report.seq < answerSeq;
  };
  const nextQuestion = (task: Task): EmergencyQuestionId | null => {
    const answered = task.answered;
    // A prior report remains a report, but a specific injury description need not be asked for again.
    const rows = o.network.store.eventsForBox(task.box_id);
    const sosSeq = rows.find((row) => row.event.event_id === task.task_id)?.seq ?? 0;
    const reportedSituation = rows.some(({ seq, event }) => seq < sosSeq && event.session_id === task.session_id && event.type === "report.heard" && /\b(bleed\w*|blood|breath\w*|unconscious|hurt|injur\w*|fell|burn\w*|pain|cut|accident)\b/i.test(event.text));
    if (!answered.has("situation") && !reportedSituation) return "situation";
    if (!answered.has("people_count")) return "people_count";
    if (location(task).kind === "unavailable" && !answered.has("location")) return "location";
    return null;
  };
  const questionPush = (task: Task): BoxPush | null => task.pending
    ? { type: "emergency.question", incident_id: task.incident_id, task_id: task.task_id, session_id: task.session_id, question_id: task.pending, prompt: PROMPTS[task.pending] }
    : null;
  const deliverQuestion = (task: Task) => {
    const push = questionPush(task);
    if (!push || push.type !== "emergency.question") return;
    if (!o.speak) {
      task.delivered = push;
      send(task, push);
      return;
    }
    const controller = new AbortController();
    task.speechAbort = controller;
    let timeout: ReturnType<typeof setTimeout>;
    const bounded = Promise.race([
      o.speak(push.prompt, controller.signal),
      new Promise<null>((resolve) => { timeout = setTimeout(() => { controller.abort(new Error("speech deadline")); resolve(null); }, 1_200); timeout.unref?.(); }),
    ]);
    void bounded.then((speech) => {
      if (stopped || task.cancelled || task.pending !== push.question_id) return;
      const delivered: BoxPush = speech && speech.data_base64.length <= MAX_PUSH_SPEECH_CHARS ? { ...push, speech } : push;
      task.delivered = delivered;
      send(task, delivered);
    }).catch(() => {
      if (stopped || task.cancelled || task.pending !== push.question_id) return;
      task.delivered = push;
      send(task, push);
    }).finally(() => {
      clearTimeout(timeout);
      if (task.speechAbort === controller) task.speechAbort = null;
    });
  };
  const update = (task: Task) => {
    const incident = o.network.store.getIncident(task.incident_id)?.incident;
    if (!incident || incident.closed) {
      if (task.cancelled) return;
      task.cancelled = true;
      task.pending = null;
      if (task.timer) clearTimeout(task.timer);
      task.speechAbort?.abort();
      task.speechAbort = null;
      task.timer = null;
      task.delivered = null;
      send(task, { type: "emergency.status", incident_id: task.incident_id, task_id: task.task_id, session_id: task.session_id, state: "cancelled" });
      tasks.delete(task.incident_id);
      return;
    }
    if (!hasContext(task) && !task.waited) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    const next = nextQuestion(task);
    if (next === task.pending) return;
    task.speechAbort?.abort();
    task.speechAbort = null;
    task.delivered = null;
    task.pending = next;
    if (next) {
      deliverQuestion(task);
    } else if (!task.ready) {
      task.ready = true;
      send(task, { type: "emergency.status", incident_id: task.incident_id, task_id: task.task_id, session_id: task.session_id, state: "facts_ready" });
    }
  };
  const start = (incidentId: string) => {
    if (stopped || tasks.has(incidentId)) return;
    const entry = o.network.store.getIncident(incidentId);
    if (!entry || entry.incident.closed) return;
    const previous = saved.get(incidentId);
    const task: Task = { incident_id: incidentId, box_id: entry.incident.box_id, session_id: entry.incident.session_id, task_id: entry.sos_event_id, pending: null, ready: false, cancelled: false, waited: previous?.task_id === entry.sos_event_id ? previous.waited : false, timer: null, speechAbort: null, delivered: null, answered: new Set(previous?.task_id === entry.sos_event_id ? previous.answered : []), usedReports: new Set(previous?.task_id === entry.sos_event_id ? previous.used_reports : []) };
    tasks.set(incidentId, task);
    send(task, { type: "emergency.status", incident_id: task.incident_id, task_id: task.task_id, session_id: task.session_id, state: "collecting_facts" });
    task.timer = setTimeout(() => { task.waited = true; update(task); }, o.contextWaitMs ?? CONTEXT_WAIT_MS);
    task.timer.unref?.();
    update(task);
  };
  const off = o.network.subscribe((change) => {
    if (change.kind === "incident") {
      if (change.incident.closed) {
        const task = tasks.get(change.incident.incident_id);
        if (task) update(task);
      } else start(change.incident.incident_id);
      return;
    }
    if (change.kind !== "event") return;
    if (change.event.type === "sos.opened") {
      // The store publishes the event before ingest creates its incident.
      queueMicrotask(() => {
        const open = o.network.store.openIncidentForBox(change.event.box_id);
        if (open?.sos_event_id === change.event.event_id) start(open.incident.incident_id);
      });
    } else if (change.event.type === "emergency.context" || change.event.type === "emergency.answer") {
      for (const task of tasks.values()) if (task.box_id === change.event.box_id && task.session_id === change.event.session_id) {
        if (change.event.type === "emergency.answer" && task.pending === change.event.question_id && !task.usedReports.has(change.event.source_event_id) && validAnswer(task, change.event)) {
          task.answered.add(change.event.question_id);
          task.usedReports.add(change.event.source_event_id);
        }
        update(task);
      }
    }
  });
  for (const entry of o.network.store.listIncidents()) if (!entry.incident.closed) start(entry.incident.incident_id);
  return {
    pendingForBox(boxId) {
      const task = [...tasks.values()].find((item) => item.box_id === boxId && !item.cancelled);
      return task?.delivered ?? null;
    },
    state(incidentId) {
      const task = tasks.get(incidentId);
      return task ? { task_id: task.task_id, pending: task.pending, ready: task.ready, cancelled: task.cancelled, location: location(task) } : null;
    },
    exportState() {
      return [...tasks.values()].map((task) => ({ incident_id: task.incident_id, task_id: task.task_id, waited: task.waited, answered: [...task.answered], used_reports: [...task.usedReports] }));
    },
    stop() {
      stopped = true;
      off();
      for (const task of tasks.values()) {
        if (task.timer) clearTimeout(task.timer);
        task.speechAbort?.abort();
      }
    },
  };
}

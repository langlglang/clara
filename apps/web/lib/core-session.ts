import { actionAllowed, type TurnRequest, type TurnResponse, type TurnState } from "@clara/contracts";
import type { Network } from "@clara/network";
import type { EmergencyWorker } from "./emergency";

type ActionRecord = NonNullable<TurnState["core_context"]>["actions"][number];
interface Session {
  updated: number;
  turns: TurnState["recent_turns"];
  actions: ActionRecord[];
  replies: Map<string, TurnResponse>;
}

/** One Core Clara context per lid session. Raw audio/images never enter this book. */
export function createCoreSessionBook(network: Network, emergency: EmergencyWorker, now = Date.now) {
  const sessions = new Map<string, Session>();
  const key = (boxId: string, sessionId: string) => `${boxId}:${sessionId}`;
  const get = (boxId: string, request: TurnRequest): Session => {
    const id = key(boxId, request.session_id);
    for (const [old, value] of sessions) if (now() - value.updated > 30 * 60_000) sessions.delete(old);
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
      session = { updated: now(), turns: request.state.recent_turns.slice(-12), actions: [], replies: new Map() };
      sessions.set(id, session);
    }
    session.updated = now();
    return session;
  };
  return {
    prepare(boxId: string, request: TurnRequest): TurnRequest {
      const session = get(boxId, request);
      const reports = network.store.eventsForBox(boxId)
        .filter(({ event }) => event.session_id === request.session_id && event.type === "report.heard")
        .slice(-4)
        .map(({ event }) => ({ source_event_id: event.event_id, at: event.occurred_at, text: event.type === "report.heard" ? event.text.slice(0, 500) : "" }));
      const incident = network.openIncidentForBox(boxId);
      const task = incident?.incident.session_id === request.session_id ? emergency.state(incident.incident.incident_id) : null;
      const core_context: NonNullable<TurnState["core_context"]> = {
        reports,
        actions: session.actions.slice(-6),
        emergency_task: task && !task.cancelled ? { task_id: task.task_id, state: task.ready ? "facts_ready" : "collecting_facts" } : null,
      };
      return { ...request, state: { ...request.state, recent_turns: session.turns.slice(-12), core_context } };
    },
    cached(boxId: string, request: TurnRequest): TurnResponse | null {
      return get(boxId, request).replies.get(request.client_turn_id) ?? null;
    },
    finish(boxId: string, request: TurnRequest, response: TurnResponse, cancelled = false): void {
      if (cancelled || response.client_turn_id !== request.client_turn_id) return;
      const session = get(boxId, request);
      if (session.replies.has(request.client_turn_id)) return;
      if (response.heard) session.turns.push({ from: "person", words: response.heard });
      if (response.reply) session.turns.push({ from: "clara", words: response.reply });
      session.turns = session.turns.slice(-12);
      const action = response.action;
      if (action && actionAllowed(action, request.state) && ["locate_item", "show_visual", "suggest_sos", "read_pulse", "request_camera", "capture_camera"].includes(action.name)) {
        const id = action.name === "locate_item" ? action.sku : action.name === "show_visual" ? action.visual_id : null;
        session.actions.push({ name: action.name as ActionRecord["name"], id, status: "requested", at: new Date(now()).toISOString() });
        session.actions = session.actions.slice(-6);
      }
      session.replies.set(request.client_turn_id, response);
      if (session.replies.size > 4) session.replies.delete(session.replies.keys().next().value!);
    },
    clear(): void { sessions.clear(); },
  };
}
export type CoreSessionBook = ReturnType<typeof createCoreSessionBook>;

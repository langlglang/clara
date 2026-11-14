// Adapted from the pre-event Clara scaffold (Clara/box/src/conversation.ts): one typed turn, used by the
// simulator in place of the microphone. The hands-free voice loop (box/src/voice) does the same for audio.
import { randomUUID } from "node:crypto";
import { VOICE_TURN_VERSION, type TurnRequest, type TurnResponse } from "@clara/contracts";
import type { CloudLink } from "../ports.js";
import { systemClock, withDeadline, type Clock } from "./clock.js";
import type { BoxSession } from "./session.js";

/** The box's deadline for one turn, a little longer than the server's own budget. */
export const TURN_DEADLINE_MS = 10_000;

export const TURN_LINES = {
  noSession: "Open the box first.",
  unreachable: "I can't reach the assistant right now. The SOS button is available.",
} as const;

export type TextTurnResult =
  | { ok: true; response: TurnResponse; actionApplied: boolean }
  | { ok: false; reason: "no_session" | "failed" };

/**
 * Sends what the bystander typed as one turn. The reply is spoken unless the action moved to a step (then
 * the step's own recorded words play). An action the box doesn't allow now is ignored and the reply still
 * plays. Any failure ends in a fixed line and the local simulated SOS remains available.
 */
export async function textTurn(
  session: BoxSession,
  cloud: CloudLink,
  text: string,
  o: { clock?: Clock; deadlineMs?: number; newId?: () => string; signal?: AbortSignal } = {},
): Promise<TextTurnResult> {
  const state = session.turnState();
  const sessionId = session.sessionId;
  if (!state || !sessionId) {
    session.say(TURN_LINES.noSession);
    return { ok: false, reason: "no_session" };
  }
  const words = text.trim().slice(0, 500);
  const request: TurnRequest = {
    schema_version: VOICE_TURN_VERSION,
    client_turn_id: (o.newId ?? randomUUID)(),
    session_id: sessionId,
    language: session.language,
    input: { type: "text", text: words },
    state,
  };
  session.remember("person", words);
  session.heard(words, request.client_turn_id);
  let response: TurnResponse;
  try {
    response = await withDeadline(o.clock ?? systemClock, o.deadlineMs ?? TURN_DEADLINE_MS, (signal) => cloud.voiceTurn(request, signal), o.signal);
  } catch {
    session.say(TURN_LINES.unreachable);
    return { ok: false, reason: "failed" };
  }
  if (session.sessionId !== sessionId || !session.turnState()) return { ok: false, reason: "no_session" };
  // Text turns know the exact input; do not let a mismatched server transcript become an SOS answer.
  const checked = response.action && (["answer_emergency_question", "request_camera", "capture_camera", "show_visual", "start_guidance"].includes(response.action.name) ||
    (response.action.name === "select_step" && state.guided_active));
  const actionApplied = response.action && response.client_turn_id === request.client_turn_id && session.sessionId === sessionId &&
    (!checked || response.heard === words)
    ? session.applyAction(response.action, "voice", checked ? response : undefined) : false;
  session.remember("clara", response.reply);
  const moved = actionApplied && (response.action?.name === "select_step" || response.action?.name === "start_guidance");
  if (!moved && response.reply) {
    session.say(response.reply, response.speech ? Buffer.from(response.speech.data_base64, "base64") : undefined, !actionApplied);
  }
  return { ok: true, response, actionApplied };
}

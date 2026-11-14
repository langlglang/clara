import { VOICE_TURN_VERSION, type Action, type TurnRequest, type TurnResponse } from "@clara/contracts";

/**
 * The simulator's FAKE assistant: keyword rules over the typed text, so the loop can be shown without a
 * server or a model. It only ever picks from what the turn state offers, like the real one must.
 */
export function simResponder(request: TurnRequest): TurnResponse {
  const text = request.input.type === "text" ? request.input.text.toLowerCase() : "";
  const state = request.state;
  let action: Action | null = null;
  let reply = "(fake assistant) I can only match step names here. Follow the screen.";

  const step = state.allowed_steps.slice(1).find((s) => text.includes(s.label.toLowerCase()) || text.includes(s.step_id.toLowerCase()));
  const item = state.manifest.find((m) => text.includes(m.name.toLowerCase()) || text.includes(m.sku.toLowerCase()));
  if (/\b(sos|911|emergency)\b/.test(text)) {
    action = { name: "suggest_sos" };
    reply = "(fake assistant) Opening the simulated SOS. You can cancel it.";
  } else if (step) {
    action = { name: "select_step", step_id: step.step_id };
    reply = step.label;
  } else if (/\b(next|done|ok|okay)\b/.test(text) && state.allowed_steps.length > 1) {
    action = { name: "select_step", step_id: state.allowed_steps[1]!.step_id };
    reply = state.allowed_steps[1]!.label;
  } else if (/\bwhere\b/.test(text) && item) {
    action = { name: "locate_item", sku: item.sku };
    reply = `(fake assistant) Lighting the compartment for ${item.name}.`;
  } else if (/\b(again|repeat)\b/.test(text) && state.step_id) {
    action = { name: "select_step", step_id: state.step_id };
    reply = "";
  }
  return {
    schema_version: VOICE_TURN_VERSION,
    client_turn_id: request.client_turn_id,
    heard: request.input.type === "text" ? request.input.text : null,
    reply,
    action,
    answered_by: "fixed",
    reason: action ? null : "no_model",
    speech: null,
  };
}

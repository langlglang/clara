import { BoxPushSchema, VOICE_TURN_VERSION, type BoxEvent, type BoxPush, type TurnRequest, type TurnResponse } from "@clara/contracts";
import type { CloudLink } from "../ports.js";
import { CloudError } from "./http.js";

export type TurnResponder = (request: TurnRequest, signal: AbortSignal) => Promise<TurnResponse> | TurnResponse;

/** A fixed "not heard" answer: what the fake says when nothing else is set. */
export function fixedReply(request: TurnRequest, reply = "I can't answer that here. Follow the step on the screen."): TurnResponse {
  return { schema_version: VOICE_TURN_VERSION, client_turn_id: request.client_turn_id, heard: null, reply, action: null, answered_by: "fixed", reason: "no_model", speech: null };
}

/**
 * An in-memory CloudLink for tests and the simulator. It keeps every event it was given, answers turns with
 * `responder`, and lets the caller push messages and switch the link on and off. No network.
 */
export class FakeCloudLink implements CloudLink {
  readonly events: BoxEvent[] = [];
  readonly turns: TurnRequest[] = [];
  responder: TurnResponder = (request) => fixedReply(request);
  private isOnline: boolean;
  private closed = false;
  private readonly pushListeners = new Set<(push: BoxPush) => void>();
  private readonly onlineListeners = new Set<(online: boolean) => void>();

  constructor(o: { online?: boolean; responder?: TurnResponder } = {}) {
    this.isOnline = o.online ?? true;
    if (o.responder) this.responder = o.responder;
  }

  get online(): boolean {
    return this.isOnline;
  }

  record(event: BoxEvent): void {
    if (!this.closed) this.events.push(event);
  }

  onPush(listener: (push: BoxPush) => void): void {
    this.pushListeners.add(listener);
  }

  onOnlineChange(listener: (online: boolean) => void): void {
    this.onlineListeners.add(listener);
  }

  async voiceTurn(request: TurnRequest, signal: AbortSignal): Promise<TurnResponse> {
    if (this.closed) throw new CloudError("closed", "The cloud link is closed.");
    if (!this.isOnline) throw new CloudError("unreachable", "Offline (fake cloud).");
    if (signal.aborted) throw new CloudError("cancelled", "Cancelled.");
    this.turns.push(request);
    return this.responder(request, signal);
  }

  /** Delivers a push as the server's stream would (validated first). */
  push(push: BoxPush): void {
    const parsed = BoxPushSchema.parse(push);
    for (const listener of this.pushListeners) listener(parsed);
  }

  setOnline(online: boolean): void {
    if (online === this.isOnline) return;
    this.isOnline = online;
    for (const listener of this.onlineListeners) listener(online);
  }

  types(): BoxEvent["type"][] {
    return this.events.map((e) => e.type);
  }

  close(): void {
    this.closed = true;
  }
}

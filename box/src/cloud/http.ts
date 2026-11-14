// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/cloud/client.ts: typed errors, a deadline on
// every call, every response checked against the contract. Walker routes, pairing and the camera are dropped;
// Clara adds the durable event outbox and the live push stream.
import {
  BoxPushSchema,
  CameraInspectResponseSchema,
  EVENTS_VERSION,
  TurnResponseSchema,
  type BoxEvent,
  type BoxPush,
  type CameraInspectRequest,
  type CameraInspectResponse,
  type EventBatch,
  type TurnRequest,
  type TurnResponse,
} from "@clara/contracts";
import type { CloudLink } from "../ports.js";
import { CancelledError, DeadlineError, systemClock, withDeadline, type Cancel, type Clock } from "../session/clock.js";
import { Outbox } from "./outbox.js";
import { SseParser } from "./sse.js";

export const BOX_ROUTES = {
  events: (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/events`,
  stream: (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/stream`,
  turns: (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/turns`,
  camera: (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/camera`,
} as const;

export type CloudErrorKind = "unreachable" | "timeout" | "cancelled" | "unauthorized" | "server_error" | "rejected" | "bad_response" | "closed";

export class CloudError extends Error {
  override name = "CloudError";
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function toCloudError(error: unknown, signal?: AbortSignal): CloudError {
  if (error instanceof CloudError) return error;
  const reason = signal?.aborted ? signal.reason : error;
  if (reason instanceof DeadlineError) return new CloudError("timeout", reason.message);
  if (reason instanceof CancelledError) return new CloudError("cancelled", "Cancelled.");
  if (signal?.aborted) return new CloudError("cancelled", "Cancelled.");
  return new CloudError("unreachable", "Couldn't reach the server.");
}

function errorFromStatus(status: number): CloudError {
  if (status === 401 || status === 403) return new CloudError("unauthorized", "The server doesn't accept this box.", status);
  if (status >= 500 || status === 408 || status === 429) return new CloudError("server_error", `Server answered ${status}.`, status);
  return new CloudError("rejected", `Request refused with ${status}.`, status);
}

/** http or https only. Plain http to another machine is allowed (a LAN demo server) but should be rare. */
export function checkServerUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The server URL must be http:// or https://.");
  return url;
}

export interface CloudDeadlines {
  /** One events POST. */
  postMs: number;
  /** One voice turn (the server's own budget is shorter). */
  turnMs: number;
  /** Until the stream's headers arrive. */
  connectMs: number;
  /** The stream counts as dead after this long with no byte (the server sends keepalives). */
  idleMs: number;
}

export const DEFAULT_DEADLINES: CloudDeadlines = { postMs: 5_000, turnMs: 10_000, connectMs: 5_000, idleMs: 45_000 };

export interface HttpCloudLinkOptions {
  serverUrl: string;
  boxId: string;
  /** Optional bearer token for the box API. Never logged. */
  token?: string | null;
  /** Folder for the outbox (`.box-state/`). */
  stateDir: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  deadlines?: Partial<CloudDeadlines>;
  retry?: { minMs: number; maxMs: number };
  batchSize?: number;
  /** Subscribe to the push stream (default true). */
  stream?: boolean;
  log?: (line: string) => void;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The box's link to the server. Events go into a durable outbox and are posted in order, in batches, until
 * the server takes them (re-sending is harmless: the server dedupes by event_id). Pushes arrive over one
 * long-lived SSE stream, reconnected with backoff. `online` is true after the last request or stream
 * connection succeeded and false after one failed.
 */
export class HttpCloudLink implements CloudLink {
  readonly outbox: Outbox;
  private readonly server: URL;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlines: CloudDeadlines;
  private readonly retry: { minMs: number; maxMs: number };
  private readonly batchSize: number;
  private readonly log: (line: string) => void;
  private readonly pushListeners = new Set<(push: BoxPush) => void>();
  private readonly onlineListeners = new Set<(online: boolean) => void>();
  private isOnline = false;
  private closed = false;
  private started = false;
  private flushing: Promise<void> | null = null;
  private flushWanted = false;
  private flushBackoff: number;
  private retryCancel: Cancel | null = null;
  private streamAbort: AbortController | null = null;
  private wakeStream: (() => void) | null = null;

  constructor(private readonly o: HttpCloudLinkOptions) {
    this.server = checkServerUrl(o.serverUrl);
    this.clock = o.clock ?? systemClock;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.deadlines = { ...DEFAULT_DEADLINES, ...o.deadlines };
    this.retry = o.retry ?? { minMs: 1_000, maxMs: 30_000 };
    this.flushBackoff = this.retry.minMs;
    this.batchSize = Math.min(100, Math.max(1, o.batchSize ?? 100));
    this.log = o.log ?? (() => {});
    this.outbox = new Outbox(o.stateDir, this.log);
  }

  /** Starts sending queued events and, unless turned off, the push stream. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.o.stream !== false) void this.streamLoop();
    void this.flush();
  }

  get online(): boolean {
    return this.isOnline;
  }

  record(event: BoxEvent): void {
    if (this.closed) return;
    this.outbox.add(event);
    if (this.started) void this.flush();
  }

  onPush(listener: (push: BoxPush) => void): void {
    this.pushListeners.add(listener);
  }

  onOnlineChange(listener: (online: boolean) => void): void {
    this.onlineListeners.add(listener);
  }

  async voiceTurn(request: TurnRequest, signal: AbortSignal): Promise<TurnResponse> {
    if (this.closed) throw new CloudError("closed", "The cloud link is closed.");
    try {
      const json = await withDeadline(this.clock, this.deadlines.turnMs, (s) => this.request("POST", BOX_ROUTES.turns(this.o.boxId), request, s), signal);
      const parsed = TurnResponseSchema.safeParse(json);
      if (!parsed.success || parsed.data.client_turn_id !== request.client_turn_id) throw new CloudError("bad_response", "Turn response doesn't match the contract.");
      this.setOnline(true);
      return parsed.data;
    } catch (error) {
      const failure = toCloudError(error, signal.aborted ? signal : undefined);
      if (failure.kind === "unreachable" || failure.kind === "timeout") this.setOnline(false);
      throw failure;
    }
  }

  async inspectCamera(request: CameraInspectRequest, signal: AbortSignal): Promise<CameraInspectResponse> {
    if (this.closed) throw new CloudError("closed", "The cloud link is closed.");
    if (!this.o.token) throw new CloudError("unauthorized", "Camera upload needs a box token.");
    const json = await withDeadline(this.clock, 10_000, (s) => this.request("POST", BOX_ROUTES.camera(this.o.boxId), request, s), signal);
    const parsed = CameraInspectResponseSchema.safeParse(json);
    if (!parsed.success || parsed.data.task_id !== request.task_id) throw new CloudError("bad_response", "Camera response was invalid.");
    return parsed.data;
  }

  /** Sends what is queued, in order. One drain at a time; resolves when the outbox is empty or a send failed. */
  flush(): Promise<void> {
    // An event recorded while a drain is finishing must not be left behind: drain again until nothing new came.
    this.flushWanted = true;
    if (!this.flushing) {
      this.flushing = (async () => {
        while (this.flushWanted && !this.closed) {
          this.flushWanted = false;
          if (!(await this.drain())) break;
        }
      })().finally(() => (this.flushing = null));
    }
    return this.flushing;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.retryCancel?.();
    this.streamAbort?.abort(new CancelledError("closed"));
    this.wakeStream?.();
  }

  // ---------- events ----------

  /** True when the outbox emptied, false when a send failed (a retry is scheduled). */
  private async drain(): Promise<boolean> {
    while (!this.closed) {
      const batch = this.outbox.peek(this.batchSize);
      if (batch.length === 0) return true;
      const body: EventBatch = { schema_version: EVENTS_VERSION, events: batch };
      try {
        await withDeadline(this.clock, this.deadlines.postMs, (s) => this.request("POST", BOX_ROUTES.events(this.o.boxId), body, s));
        this.outbox.ack(batch.map((e) => e.event_id));
        this.flushBackoff = this.retry.minMs;
        this.setOnline(true);
      } catch (error) {
        const failure = toCloudError(error);
        if (failure.kind === "rejected" && (failure.status === 400 || failure.status === 413 || failure.status === 422)) {
          // The server refused the batch itself (400): retrying the same bytes would wedge the outbox forever.
          this.log(`events: batch of ${batch.length} refused (${failure.status ?? "?"}); dropped`);
          this.outbox.ack(batch.map((e) => e.event_id));
          continue;
        }
        if (failure.kind !== "unauthorized") this.setOnline(false);
        this.log(`events: send failed (${failure.kind}); ${this.outbox.size} waiting, retry in ${Math.round(this.flushBackoff / 1000)} s`);
        this.scheduleRetry();
        return false;
      }
    }
    return false;
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryCancel) return;
    const wait = this.flushBackoff;
    this.flushBackoff = Math.min(this.retry.maxMs, this.flushBackoff * 2);
    this.retryCancel = this.clock.setTimeout(() => {
      this.retryCancel = null;
      void this.flush();
    }, wait);
  }

  // ---------- push stream ----------

  private async streamLoop(): Promise<void> {
    let backoff = this.retry.minMs;
    while (!this.closed) {
      const controller = new AbortController();
      this.streamAbort = controller;
      try {
        const cancelConnect = this.clock.setTimeout(() => controller.abort(new DeadlineError("stream connect")), this.deadlines.connectMs);
        let response: Response;
        try {
          response = await this.fetchImpl(new URL(BOX_ROUTES.stream(this.o.boxId), this.server), {
            method: "GET",
            headers: this.headers({ accept: "text/event-stream" }),
            signal: controller.signal,
            redirect: "error",
          });
        } finally {
          cancelConnect();
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw errorFromStatus(response.status);
        }
        this.setOnline(true);
        backoff = this.retry.minMs;
        void this.flush();
        await this.readStream(response.body, controller);
        if (!this.closed) this.log("stream: ended by the server; reconnecting");
      } catch (error) {
        if (this.closed) break;
        this.log(`stream: ${toCloudError(error, controller.signal).kind}; reconnecting in ${Math.round(backoff / 1000)} s`);
      }
      if (this.closed) break;
      this.setOnline(false);
      await this.sleep(backoff);
      backoff = Math.min(this.retry.maxMs, backoff * 2);
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let cancelIdle: Cancel = () => {};
    const armIdle = () => {
      cancelIdle();
      cancelIdle = this.clock.setTimeout(() => controller.abort(new DeadlineError("stream idle")), this.deadlines.idleMs);
    };
    const onAbort = () => void reader.cancel().catch(() => {});
    controller.signal.addEventListener("abort", onAbort, { once: true });
    armIdle();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) return;
        armIdle();
        for (const message of parser.feed(decoder.decode(value, { stream: true }))) this.deliver(message.event, message.data);
      }
    } finally {
      cancelIdle();
      controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted && !this.closed) throw controller.signal.reason;
    }
  }

  private deliver(event: string, data: string): void {
    if (event !== "message" && event !== "push") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.log("stream: a message that isn't JSON was ignored");
      return;
    }
    const parsed = BoxPushSchema.safeParse(json);
    if (!parsed.success) {
      this.log("stream: a message that doesn't match BoxPush was ignored");
      return;
    }
    for (const listener of this.pushListeners) {
      try {
        listener(parsed.data);
      } catch (error) {
        this.log(`push listener failed: ${(error as Error).message}`);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.clock.setTimeout(() => {
        this.wakeStream = null;
        resolve();
      }, ms);
      this.wakeStream = () => {
        cancel();
        this.wakeStream = null;
        resolve();
      };
    });
  }

  // ---------- plumbing ----------

  private headers(extra: Record<string, string>): Record<string, string> {
    return { ...extra, ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) };
  }

  private async request(method: "POST", path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(new URL(path, this.server), {
        method,
        headers: this.headers({ accept: "application/json", "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw toCloudError(error, signal);
    }
    if (status < 200 || status > 299) throw errorFromStatus(status);
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new CloudError("bad_response", "Response too large.", status);
    try {
      return text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new CloudError("bad_response", "Response isn't JSON.", status);
    }
  }

  private setOnline(online: boolean): void {
    if (online === this.isOnline) return;
    this.isOnline = online;
    for (const listener of this.onlineListeners) {
      try {
        listener(online);
      } catch {
        // A listener's failure doesn't change the link.
      }
    }
  }
}

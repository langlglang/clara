import type { BoardEvent } from "../ports.js";
import type { Logger } from "./log.js";

type Listener = (event: BoardEvent) => void;

/**
 * Fans board events out to listeners and remembers the latest link state, lid and mount, so a listener that
 * subscribes after `openBoard` resolved still learns them. The replay is a snapshot taken when it subscribed,
 * delivered on the next microtask or just before the next live event, whichever comes first, so it never
 * arrives after something newer. Pulse readings are never replayed: an old reading is not a current one.
 */
export class EventHub {
  private readonly listeners: Array<{ listener: Listener; replay: BoardEvent[] | null }> = [];
  private link: Extract<BoardEvent, { type: "connected" | "disconnected" }> | null = null;
  private lid: Extract<BoardEvent, { t: "lid" }> | null = null;
  private mount: Extract<BoardEvent, { t: "mount" }> | null = null;

  constructor(private readonly log: Logger) {}

  on(listener: Listener): void {
    const replay: BoardEvent[] = [];
    if (this.link) replay.push(this.link);
    if (this.link?.type === "connected") {
      if (this.lid) replay.push(this.lid);
      if (this.mount) replay.push(this.mount);
    }
    const entry = { listener, replay: replay.length ? replay : null };
    this.listeners.push(entry);
    if (entry.replay) queueMicrotask(() => this.flush(entry));
  }

  emit(event: BoardEvent): void {
    if ("type" in event) {
      this.link = event;
      if (event.type === "disconnected") {
        this.lid = null;
        this.mount = null;
      }
    } else if (event.t === "lid") this.lid = event;
    else if (event.t === "mount") this.mount = event;
    for (const entry of [...this.listeners]) {
      this.flush(entry);
      this.call(entry.listener, event);
    }
  }

  /** The latest known lid state, or null when unknown (board not connected yet). */
  get lidOpen(): boolean | null {
    return this.lid ? this.lid.open : null;
  }

  get onWall(): boolean | null {
    return this.mount ? this.mount.on_wall : null;
  }

  get connected(): boolean {
    return this.link?.type === "connected";
  }

  private flush(entry: { listener: Listener; replay: BoardEvent[] | null }): void {
    const replay = entry.replay;
    if (!replay) return;
    entry.replay = null;
    for (const event of replay) this.call(entry.listener, event);
  }

  private call(listener: Listener, event: BoardEvent): void {
    try {
      listener(event);
    } catch (error) {
      this.log.error("board event listener threw", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

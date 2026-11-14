// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/store.ts: one state folder, atomic writes.
// Sophi kept its status events in memory; Clara's events are the incident record, so they go to disk.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxEventSchema, type BoxEvent } from "@clara/contracts";

/** Past this many unsent events the oldest heartbeats go first, then the oldest events. */
export const MAX_OUTBOX = 5_000;

/**
 * The durable outbox: box events waiting for the server, oldest first, in `<stateDir>/outbox.json`. Survives a
 * restart or a power cut (written with a temp file and a rename). An unreadable file is set aside and the box
 * starts with an empty outbox rather than not starting.
 */
export class Outbox {
  private events: BoxEvent[] = [];
  private readonly file: string;

  constructor(
    readonly dir: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "outbox.json");
    this.events = this.read();
  }

  get size(): number {
    return this.events.length;
  }

  add(event: BoxEvent): void {
    const parsed = BoxEventSchema.safeParse(event);
    if (!parsed.success) {
      this.log(`outbox: event ${String((event as { type?: unknown }).type)} dropped, it doesn't match the contract`);
      return;
    }
    if (this.events.some((e) => e.event_id === parsed.data.event_id)) return;
    this.events.push(parsed.data);
    this.trim();
    this.write();
  }

  /** The oldest `max` events, to send next. */
  peek(max: number): BoxEvent[] {
    return this.events.slice(0, max);
  }

  /** Removes events the server took. */
  ack(ids: readonly string[]): void {
    const sent = new Set(ids);
    const before = this.events.length;
    this.events = this.events.filter((e) => !sent.has(e.event_id));
    if (this.events.length !== before) this.write();
  }

  all(): BoxEvent[] {
    return [...this.events];
  }

  private trim(): void {
    while (this.events.length > MAX_OUTBOX) {
      const heartbeat = this.events.findIndex((e) => e.type === "box.heartbeat");
      this.events.splice(heartbeat >= 0 ? heartbeat : 0, 1);
    }
  }

  private read(): BoxEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const json: unknown = JSON.parse(raw);
      if (!Array.isArray(json)) throw new Error("not a list");
      const events: BoxEvent[] = [];
      for (const item of json) {
        const parsed = BoxEventSchema.safeParse(item);
        if (parsed.success) events.push(parsed.data);
      }
      if (events.length !== json.length) this.log(`outbox: ${json.length - events.length} unreadable events skipped`);
      return events;
    } catch {
      const aside = `${this.file}.bad-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        // Nothing more to do: the next write replaces it.
      }
      this.log("outbox: the file was unreadable and was set aside; starting empty");
      return [];
    }
  }

  private write(): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.events));
      renameSync(temp, this.file);
    } catch (error) {
      this.log(`outbox: write failed (${(error as NodeJS.ErrnoException).code ?? "unknown"}); events stay in memory`);
    }
  }
}

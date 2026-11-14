import { Duplex } from "node:stream";
import type { SerialLink } from "../src/hardware/serial-board.js";

/** A stand-in for a SerialPort: records what the Pi writes and lets a test play the board's side. */
export class FakePort extends Duplex {
  readonly lines: Array<Record<string, unknown>> = [];
  /** Answers each command the moment it is written (set to null to stay silent). */
  responder: ((command: Record<string, unknown>, port: FakePort) => void) | null = null;
  private partial = "";

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.partial += chunk.toString("utf8");
    let newline = this.partial.indexOf("\n");
    while (newline !== -1) {
      const line = JSON.parse(this.partial.slice(0, newline)) as Record<string, unknown>;
      this.partial = this.partial.slice(newline + 1);
      this.lines.push(line);
      this.responder?.(line, this);
      newline = this.partial.indexOf("\n");
    }
    callback();
  }

  /** The board sends raw bytes (any framing). */
  feed(text: string | Buffer): void {
    this.push(typeof text === "string" ? Buffer.from(text) : text);
  }

  send(message: Record<string, unknown>): void {
    this.feed(`${JSON.stringify(message)}\n`);
  }

  link(id = "/dev/fake"): SerialLink {
    return { id, stream: this };
  }
}

/** A well-behaved board: acks everything ok, and answers a ping with its hello and switch states. */
export function goodBoard(options: { leds?: number; boot?: string; lidOpen?: boolean } = {}) {
  let seq = 0;
  return (command: Record<string, unknown>, port: FakePort) => {
    port.send({ t: "ack", id: command.id, ok: true });
    if (command.t === "ping") {
      port.send({ t: "hello", proto: "1.1", fw: "clara-0.2.0", boot: options.boot ?? "b1", leds: options.leds ?? 6 });
      port.send({ t: "lid", open: options.lidOpen ?? false, seq: seq++ });
      port.send({ t: "mount", on_wall: true, seq: seq++ });
    }
  };
}

/** Lets stream events (emitted on process.nextTick) and microtasks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Test doubles for the audio layer and voice loop: a manual clock, fake child processes, a fake speaker. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Clock } from "../src/audio/clock.js";
import type { SpawnFn } from "../src/audio/process.js";
import type { CueName, Speaker, Utterance } from "../src/ports.js";

export class FakeClock implements Clock {
  private t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Moves time forward, running due timers in order (and letting promises settle between them). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  stdinData: Buffer = Buffer.alloc(0);

  constructor(
    readonly command: string,
    readonly args: string[],
  ) {
    super();
    this.stdin.on("data", (d: Buffer) => (this.stdinData = Buffer.concat([this.stdinData, d])));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  failToStart(code = "ENOENT"): void {
    this.pid = undefined;
    this.emit("error", Object.assign(new Error(`spawn ${this.command} ${code}`), { code }));
  }
}

/** A spawn that records each child; `behave` may script it (exit codes, output). */
export function fakeSpawn(behave: (child: FakeChild) => void = (child) => setImmediate(() => child.exit(0))) {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args) => {
    const child = new FakeChild(command, args);
    children.push(child);
    behave(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, children };
}

export interface ScriptedUtterance {
  kind: "speak" | "wav" | "file";
  value: string;
  finish(): void;
  fail(error?: Error): void;
  stopped: boolean;
}

/** A speaker whose lines finish only when the test says so (or at once with `auto`). */
export class FakeSpeaker implements Speaker {
  readonly label = "fake";
  readonly simulated = true;
  readonly lines: ScriptedUtterance[] = [];
  readonly cues: CueName[] = [];
  auto = false;
  failKinds = new Set<ScriptedUtterance["kind"]>();

  speak(text: string): Utterance {
    return this.make("speak", text);
  }
  playWav(wav: Buffer): Utterance {
    return this.make("wav", wav.toString());
  }
  playFile(path: string): Utterance {
    return this.make("file", path);
  }
  playCue(name: CueName): Promise<void> {
    this.cues.push(name);
    return Promise.resolve();
  }

  private make(kind: ScriptedUtterance["kind"], value: string): Utterance {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
    const line: ScriptedUtterance = {
      kind,
      value,
      stopped: false,
      finish: () => resolve(),
      fail: (error = new Error(`${kind} failed`)) => reject(error),
    };
    this.lines.push(line);
    if (this.failKinds.has(kind)) line.fail();
    else if (this.auto) line.finish();
    return {
      done,
      stop: () => {
        line.stopped = true;
        resolve();
      },
    };
  }
}

// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/serial/port.ts and devices/pi/src/serial/modules.ts.
import { existsSync } from "node:fs";
import type { Duplex } from "node:stream";
import { SERIAL_BAUD, SERIAL_MAX_LINE, ToBoardSchema, type FromBoard, type ToBoard } from "@clara/contracts";
import type { Board, BoardEvent } from "../ports.js";
import { EventHub } from "./event-hub.js";
import { LineReader, type LineResult } from "./line-reader.js";
import { createLogger, type Logger } from "./log.js";

/**
 * The real ESP32 over USB serial (the `serialport` package), speaking the contract in
 * packages/contracts/src/serial.ts: one JSON object per line, 115200 baud, every command acked by id.
 *
 * - The port is found by USB vendor (the dev board's USB-to-UART bridge) and opened by its stable
 *   /dev/serial/by-id path on Linux, never a hard-coded ttyUSB0. `CLARA_SERIAL_PORT` or `path` overrides that.
 * - On open the Pi sends a `ping`; the firmware answers with an ack, its `hello`, and its current lid and mount
 *   state, so it does not matter whether the board or the Pi started first. `connected` is emitted on hello.
 * - A ping every `heartbeatMs` keeps the board's link watchdog fed (it clears LEDs and the buzzer when the Pi
 *   goes quiet) and notices a board that stopped answering; the port is then closed and opened again.
 * - Every command resolves true only when the board acked it with ok; a nack, a timeout, or a lost link all
 *   resolve false. Nothing here throws at the caller.
 */

/** USB vendor ids of the bridges ESP32 dev boards use. Confirm the delivered board's id with `lsusb`. */
export const ESP32_USB_VENDORS: Readonly<Record<string, string>> = {
  "10c4": "Silicon Labs CP210x",
  "1a86": "WCH CH340/CH9102",
  "0403": "FTDI",
  "303a": "Espressif native USB",
};

export const SERIAL_BY_ID_DIR = "/dev/serial/by-id";

/** The fields of serialport's PortInfo this module reads. */
export interface PortInfoLike {
  path: string;
  vendorId?: string | undefined;
  productId?: string | undefined;
  manufacturer?: string | undefined;
  serialNumber?: string | undefined;
  pnpId?: string | undefined;
}

export interface PortChoice {
  path: string;
  why: string;
}

/** What `pickBoardPort` decided about each listed port, for the check CLI. */
export function describePort(port: PortInfoLike): { candidate: boolean; bridge: string | null } {
  const vendor = port.vendorId?.toLowerCase();
  const bridge = vendor ? (ESP32_USB_VENDORS[vendor] ?? null) : null;
  if (bridge) return { candidate: true, bridge };
  const name = `${port.manufacturer ?? ""} ${port.pnpId ?? ""}`;
  if (/silicon.?labs|cp210|ch340|ch9102|wch|espressif/i.test(name)) return { candidate: true, bridge: port.manufacturer ?? "USB serial bridge" };
  return { candidate: false, bridge: null };
}

/**
 * The ESP32's port among `ports`, preferring its /dev/serial/by-id link on Linux (stable across replugs and
 * USB port changes). Null when none looks like an ESP32 bridge.
 */
export function pickBoardPort(
  ports: readonly PortInfoLike[],
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): PortChoice | null {
  const candidates = ports.filter((port) => describePort(port).candidate).sort((a, b) => a.path.localeCompare(b.path));
  const port = candidates[0];
  if (!port) return null;
  const { bridge } = describePort(port);
  const more = candidates.length > 1 ? ` (${candidates.length} candidates; set CLARA_SERIAL_PORT to choose)` : "";
  if (platform === "linux" && port.pnpId) {
    const byId = `${SERIAL_BY_ID_DIR}/${port.pnpId}`;
    if (exists(byId)) return { path: byId, why: `${bridge} at ${port.path}${more}` };
  }
  return { path: port.path, why: `${bridge}${more}` };
}

export async function listSerialPorts(): Promise<PortInfoLike[]> {
  const { SerialPort } = await import("serialport");
  return SerialPort.list();
}

/** One open port. `stream` is a SerialPort in production and a fake Duplex in tests. */
export interface SerialLink {
  readonly id: string;
  readonly stream: Duplex;
}

/** Opens the board's port, or resolves null (with a reason logged) when there is none to open. */
export type Connector = () => Promise<SerialLink | null>;

/** The real connector: `path` (or CLARA_SERIAL_PORT), else the discovered ESP32 port. */
export function serialConnector(options: { path?: string | undefined; log: Logger }): Connector {
  let lastProblem = "";
  const note = (problem: string) => {
    if (problem !== lastProblem) options.log.warn(problem);
    lastProblem = problem;
  };
  return async () => {
    let path = options.path ?? process.env.CLARA_SERIAL_PORT;
    if (!path) {
      let ports: PortInfoLike[];
      try {
        ports = await listSerialPorts();
      } catch (error) {
        note(`couldn't list serial ports: ${(error as Error).message}`);
        return null;
      }
      const choice = pickBoardPort(ports);
      if (!choice) {
        note("no ESP32 serial port found");
        return null;
      }
      path = choice.path;
      options.log.info("found the ESP32 serial port", { port: path, bridge: choice.why });
    }
    const { SerialPort } = await import("serialport");
    const port = new SerialPort({ path, baudRate: SERIAL_BAUD, autoOpen: false });
    try {
      await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      note(`couldn't open ${path}: ${(error as Error).message}`);
      return null;
    }
    lastProblem = "";
    return { id: path, stream: port };
  };
}

export interface SerialBoardOptions {
  connect: Connector;
  log?: Logger;
  label?: string;
  /** How long a command waits for its ack. Placeholder, not measured. */
  ackTimeoutMs?: number;
  /** Wait between attempts to find or reopen the port. */
  reconnectMs?: number;
  /** How often to ping the board. Must stay well under the firmware's link watchdog (10 s). */
  heartbeatMs?: number;
  /** Unanswered pings in a row before the port is closed and opened again. */
  maxMissedPings?: number;
}

type Command = ToBoard extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

interface Pending {
  resolve(ok: boolean): void;
  timer: NodeJS.Timeout;
  t: ToBoard["t"];
}

export type RawSensorReading = Extract<FromBoard, { t: "sensor.raw" }>;

interface PendingRaw {
  resolve(reading: RawSensorReading | null): void;
  timer: NodeJS.Timeout;
}

const MAX_ID = 2 ** 31 - 1;

export class SerialBoard implements Board {
  readonly label: string;
  readonly simulated = false;
  private readonly log: Logger;
  private readonly hub: EventHub;
  private readonly ackTimeoutMs: number;
  private readonly reconnectMs: number;
  private readonly heartbeatMs: number;
  private readonly maxMissedPings: number;
  private link: SerialLink | null = null;
  private readonly reader: LineReader;
  private readonly pending = new Map<number, Pending>();
  private readonly pendingRaw = new Map<number, PendingRaw>();
  private nextId = 1;
  private boot: string | null = null;
  private leds: number | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readWake: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private missedPings = 0;
  private closed = false;
  private announcedDown = false;
  private badLines = 0;
  private ignoredBeforeHello = 0;
  private started: Promise<void> | null = null;

  constructor(private readonly options: SerialBoardOptions) {
    this.log = options.log ?? createLogger("board");
    this.hub = new EventHub(this.log);
    this.label = options.label ?? "ESP32 over USB serial";
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1000;
    this.reconnectMs = options.reconnectMs ?? 2000;
    this.heartbeatMs = options.heartbeatMs ?? 3000;
    this.maxMissedPings = options.maxMissedPings ?? 2;
    this.reader = new LineReader((result) => this.line(result));
  }

  /** Makes the first connection attempt; later attempts run on their own. Resolves true when a port opened. */
  async start(): Promise<boolean> {
    this.started ??= this.attempt();
    await this.started;
    return this.link !== null;
  }

  /** Whether the board has said hello on the open port. */
  get connected(): boolean {
    return this.hub.connected;
  }

  get lidOpen(): boolean | null {
    return this.hub.lidOpen;
  }

  get ledCount(): number | null {
    return this.leds;
  }

  get portId(): string | null {
    return this.link?.id ?? null;
  }

  onEvent(listener: (event: BoardEvent) => void): void {
    this.hub.on(listener);
  }

  lightCompartment(channel: number, ms: number, mode: "solid" | "blink" | "pulse" = "solid"): Promise<boolean> {
    if (this.leds !== null && (channel < 0 || channel >= this.leds)) {
      this.log.warn("LED channel outside the board's range; not sent", { channel, leds: this.leds });
      return Promise.resolve(false);
    }
    return this.send({ t: "led", ch: channel, ms: Math.round(ms), mode });
  }

  clearLights(): Promise<boolean> {
    return this.send({ t: "led", ch: -1, ms: 0, mode: "solid" });
  }

  rhythm(bpm: number): Promise<boolean> {
    return this.send({ t: "rhythm", bpm: Math.round(bpm) });
  }

  buzz(pattern: "chime" | "alert" | "off"): Promise<boolean> {
    return this.send({ t: "buzz", pattern });
  }

  startPulse(): Promise<boolean> {
    return this.send({ t: "pulse.start" });
  }

  stopPulse(): Promise<boolean> {
    return this.send({ t: "pulse.stop" });
  }

  /** A fresh hardware sample, or null on a nack, timeout, disconnect, or unavailable result. */
  async readSensorRaw(): Promise<RawSensorReading | null> {
    if (!this.link || !this.connected || this.closed) return null;
    const id = this.allocateId();
    const result = new Promise<RawSensorReading | null>((resolve) => {
      const timer = setTimeout(() => this.settleRaw(id, null), 1500);
      this.pendingRaw.set(id, { resolve, timer });
    });
    if (!(await this.send({ t: "sensor.read" }, id))) this.settleRaw(id, null);
    return result;
  }

  ping(): Promise<boolean> {
    return this.send({ t: "ping" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.link) {
      // Best effort: leave nothing lit or sounding. The firmware's watchdog clears them anyway.
      const quiet = Promise.all([this.clearLights(), this.rhythm(0), this.buzz("off")]);
      await Promise.race([quiet, new Promise((resolve) => setTimeout(resolve, 300))]);
    }
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop("closed by the Pi");
  }

  /** Sends one command and resolves with its ack (false on nack, timeout, or no link). */
  send(command: Command, reservedId?: number): Promise<boolean> {
    const link = this.link;
    if (!link || this.closed) return Promise.resolve(false);
    const id = reservedId ?? this.allocateId();
    const parsed = ToBoardSchema.safeParse({ ...command, id });
    if (!parsed.success) {
      this.log.error("command failed validation; not sent", { t: command.t, problem: parsed.error.issues[0]?.message });
      return Promise.resolve(false);
    }
    const line = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(line) > SERIAL_MAX_LINE) {
      this.log.error("command longer than a serial line; not sent", { t: command.t });
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        if (command.t !== "ping") this.log.warn("no ack from the board", { t: command.t, id, ms: this.ackTimeoutMs });
        resolve(false);
      }, this.ackTimeoutMs);
      this.pending.set(id, { resolve, timer, t: command.t });
      try {
        link.stream.write(line, (error) => {
          if (!error) return;
          this.log.warn("serial write failed", { port: link.id, error: error.message });
          this.settle(id, false);
        });
      } catch (error) {
        this.log.warn("serial write failed", { port: link.id, error: (error as Error).message });
        this.settle(id, false);
      }
    });
  }

  private allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
    return id;
  }

  private settleRaw(id: number, reading: RawSensorReading | null): void {
    const entry = this.pendingRaw.get(id);
    if (!entry) return;
    this.pendingRaw.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(reading);
  }

  private settle(id: number, ok: boolean): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(ok);
    return entry;
  }

  private async attempt(): Promise<void> {
    this.retry = null;
    if (this.closed || this.link) return;
    let link: SerialLink | null = null;
    try {
      link = await this.options.connect();
    } catch (error) {
      this.log.warn("couldn't open the board's port", { error: (error as Error).message });
    }
    if (this.closed) {
      link?.stream.destroy();
      return;
    }
    if (!link) {
      this.down("no ESP32 serial port");
      this.scheduleRetry();
      return;
    }
    this.attach(link);
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => void this.attempt(), this.reconnectMs);
  }

  private attach(link: SerialLink): void {
    this.link = link;
    this.reader.reset();
    this.boot = null;
    this.missedPings = 0;
    this.ignoredBeforeHello = 0;
    this.log.info("serial port opened", { port: link.id });
    link.stream.on("data", (data: Buffer | string) => {
      if (this.link === link) this.reader.push(typeof data === "string" ? Buffer.from(data) : data);
    });
    link.stream.on("error", (error: Error) => {
      if (this.link === link) this.drop(`port error: ${error.message}`);
    });
    link.stream.on("close", () => {
      if (this.link === link) this.drop("port closed (unplugged?)");
    });
    void this.ping();
    // On the tested macOS CP210x bridge, serialport's read callback waits until another JS event
    // wakes the loop. Polling the stream cheaply keeps command ACK latency below its deadline.
    this.readWake = setInterval(() => { if (this.link === link) link.stream.read(0); }, 50);
    this.heartbeat = setInterval(() => void this.beat(), this.heartbeatMs);
  }

  private async beat(): Promise<void> {
    const link = this.link;
    const ok = await this.ping();
    if (this.link !== link || !link) return;
    if (ok) {
      this.missedPings = 0;
      return;
    }
    this.missedPings += 1;
    if (this.missedPings >= this.maxMissedPings) this.drop(`no answer to ${this.missedPings} pings`);
  }

  /** Forgets the open port (closing it), fails every waiting command, and schedules a reconnect. */
  private drop(reason: string): void {
    const link = this.link;
    this.link = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.readWake) clearInterval(this.readWake);
    this.readWake = null;
    for (const id of [...this.pending.keys()]) this.settle(id, false);
    for (const id of [...this.pendingRaw.keys()]) this.settleRaw(id, null);
    this.reader.reset();
    this.boot = null;
    if (link) {
      this.log.warn("serial link down", { port: link.id, reason });
      if (!link.stream.destroyed) link.stream.destroy();
    }
    this.down(reason);
    this.scheduleRetry();
  }

  private down(reason: string): void {
    if (this.announcedDown && !this.hub.connected) return;
    this.announcedDown = true;
    this.hub.emit({ type: "disconnected", reason });
  }

  private line(result: LineResult): void {
    if (!result.ok) {
      this.badLines += 1;
      if (this.badLines === 1 || this.badLines % 100 === 0) {
        this.log.warn("serial line refused", { problem: result.problem, detail: result.detail, count: this.badLines });
      }
      return;
    }
    this.handle(result.message);
  }

  private handle(message: FromBoard): void {
    if (message.t === "ack") {
      const entry = this.settle(message.id, message.ok);
      if (entry && !message.ok) this.log.warn("board refused a command", { t: entry.t, id: message.id, err: message.err });
      if (entry) this.missedPings = 0;
      return;
    }
    if (message.t === "hello") {
      const rebooted = this.boot !== null && this.boot !== message.boot;
      const first = this.boot === null || !this.hub.connected;
      this.boot = message.boot;
      this.leds = message.leds;
      if (first || rebooted) {
        this.log.info(rebooted ? "board restarted" : "board said hello", { firmware: message.fw, boot: message.boot, leds: message.leds });
        this.announcedDown = false;
        this.hub.emit({ type: "connected", firmware: message.fw, leds: message.leds });
      }
      return;
    }
    if (!this.hub.connected) {
      // A board that kept running while the Pi restarted: its hello comes in answer to our ping.
      this.ignoredBeforeHello += 1;
      if (this.ignoredBeforeHello === 1) this.log.warn("board line before its hello; ignored", { t: message.t });
      return;
    }
    if (message.t === "lid") {
      if (this.hub.lidOpen === message.open) return; // A re-report of the same state, not a new open.
      this.hub.emit(message);
      return;
    }
    if (message.t === "mount") {
      if (this.hub.onWall === message.on_wall) return;
      this.hub.emit(message);
      return;
    }
    if (message.t === "sensor.raw") {
      if (!this.pendingRaw.has(message.id)) return; // An expired request cannot become a current reading.
      const valid = message.quality === "valid" && message.red !== null && message.ir !== null;
      const unavailable = message.quality === "unavailable" && message.red === null && message.ir === null;
      this.settleRaw(message.id, valid ? message : null);
      if (valid || unavailable) this.hub.emit(message);
      return;
    }
    // Pulse: passed on as is. A null bpm stays null; nothing here invents a number.
    this.hub.emit(message);
  }
}

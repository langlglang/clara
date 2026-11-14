// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/check/modules.ts (the serial board check).
import type { BoardEvent } from "../ports.js";
import { SerialBoard, SimBoard, describePort, listSerialPorts, pickBoardPort, serialConnector, silentLogger, type PortInfoLike } from "../hardware/index.js";
import { fail, pass, skip, warn, type Check, type CheckLine } from "./core.js";

export interface BoardCheckOptions {
  /** `--port`: this serial port instead of discovery. */
  port: string | undefined;
  /** `--sim`: run the board checks against the simulated board. */
  sim: boolean;
  /** `--leds`: blink each LED channel in turn. */
  leds: boolean;
  /** `--beep`: one short chime on the buzzer. */
  beep: boolean;
  /** `--lid`: wait for the lid to be opened and closed. */
  lid: boolean;
  /** `--pulse`: run the pulse sensor for a few seconds. */
  pulse: boolean;
}

/** The parts of a board the check uses: SerialBoard, or SimBoard in `--sim`. */
export interface CheckableBoard {
  readonly label: string;
  onEvent(listener: (event: BoardEvent) => void): void;
  lightCompartment(channel: number, ms: number, mode?: "solid" | "blink" | "pulse"): Promise<boolean>;
  clearLights(): Promise<boolean>;
  buzz(pattern: "chime" | "alert" | "off"): Promise<boolean>;
  startPulse(): Promise<boolean>;
  stopPulse(): Promise<boolean>;
  close(): Promise<void>;
  ping?(): Promise<boolean>;
}

export interface BoardSource {
  listPorts(): Promise<PortInfoLike[]>;
  /** Opens the board (real or simulated); resolves null with a reason when there is no port. */
  open(options: BoardCheckOptions): Promise<{ board: CheckableBoard; id: string } | { error: string }>;
}

export const realBoardSource: BoardSource = {
  listPorts: listSerialPorts,
  async open(options) {
    if (options.sim) {
      const board = new SimBoard({ log: silentLogger, lidOpen: false });
      return { board, id: "simulated" };
    }
    let path = options.port ?? process.env.CLARA_SERIAL_PORT;
    if (!path) {
      const choice = pickBoardPort(await listSerialPorts());
      if (!choice) return { error: "no port looks like an ESP32 (CP210x, CH340/CH9102, FTDI or Espressif USB)" };
      path = choice.path;
    }
    const board = new SerialBoard({ connect: serialConnector({ path, log: silentLogger }), log: silentLogger, reconnectMs: 60_000 });
    if (!(await board.start())) return { error: `couldn't open ${path} (in the dialout group? another program using it?)` };
    return { board, id: path };
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isConnected = (e: BoardEvent): e is Extract<BoardEvent, { type: "connected" }> => "type" in e && e.type === "connected";
const isLid = (e: BoardEvent): e is Extract<BoardEvent, { t: "lid" }> => "t" in e && e.t === "lid";
const isPulse = (e: BoardEvent): e is Extract<BoardEvent, { t: "pulse" }> => "t" in e && e.t === "pulse";

export function portsCheck(source: BoardSource): Check {
  return {
    name: "serial",
    timeoutMs: 5000,
    async run() {
      const ports = await source.listPorts();
      if (ports.length === 0) return [fail("serial", "ports", "no serial ports at all: is the ESP32's USB cable a data cable?")];
      const lines = ports.map((port) => {
        const { candidate, bridge } = describePort(port);
        const id = [port.vendorId && `${port.vendorId}:${port.productId ?? "?"}`, port.manufacturer, port.pnpId].filter(Boolean).join(" ");
        return candidate ? pass("serial", "port", `${port.path}: ${bridge} (${id})`) : skip("serial", "port", `${port.path}: not an ESP32 bridge${id ? ` (${id})` : ""}`);
      });
      const choice = pickBoardPort(ports);
      lines.push(choice ? pass("serial", "chosen", `${choice.path}: ${choice.why}`) : fail("serial", "chosen", "none of these looks like the ESP32"));
      return lines;
    },
  };
}

/** Opens the board once and runs every board item on it; the board is closed at the end whatever happens. */
export function boardCheck(source: BoardSource, options: BoardCheckOptions, say: (line: string) => void): Check {
  const lidWaitMs = 20_000;
  const pulseMs = 12_000;
  return {
    name: "board",
    timeoutMs: 15_000 + (options.lid ? 2 * lidWaitMs : 0) + (options.pulse ? pulseMs : 0) + (options.leds ? 16 * 900 : 0),
    async run() {
      const opened = await source.open(options);
      if ("error" in opened) return [fail("board", "open", opened.error)];
      const { board, id } = opened;
      const events: BoardEvent[] = [];
      board.onEvent((event) => events.push(event));
      const lines: CheckLine[] = [];
      try {
        const hello = await waitForAfter(events, 0, isConnected, 5000);
        if (!hello) {
          lines.push(fail("board", "hello", `${id}: no hello within 5 s (wrong firmware or baud rate? try: pio device monitor -b 115200)`));
          return lines;
        }
        lines.push(pass("board", "hello", `${board.label} on ${id}: firmware ${hello.firmware}, ${hello.leds} LED channels`));
        if (board.ping) {
          const started = Date.now();
          const ok = await board.ping();
          lines.push(ok ? pass("board", "ping", `acked in ${Date.now() - started} ms`) : fail("board", "ping", "no ack"));
        }
        const lid = events.find(isLid);
        lines.push(lid ? pass("board", "lid", `reads ${lid.open ? "open" : "closed"}`) : warn("board", "lid", "no lid state reported"));
        const mount = events.find((e): e is Extract<BoardEvent, { t: "mount" }> => "t" in e && e.t === "mount");
        lines.push(mount ? pass("board", "mount", `reads ${mount.on_wall ? "on the wall" : "off the wall"}`) : warn("board", "mount", "no mount state reported"));

        if (!options.leds) lines.push(skip("board", "LEDs", "pass --leds to light each channel in turn"));
        else {
          if (lid && !lid.open) say("The lid reads closed; the firmware refuses LED commands until it is open.");
          const refused: number[] = [];
          for (let ch = 0; ch < hello.leds; ch += 1) {
            say(`LED channel ${ch} should blink now.`);
            if (!(await board.lightCompartment(ch, 800, "blink"))) refused.push(ch);
            await sleep(900);
          }
          await board.clearLights();
          lines.push(
            refused.length === 0
              ? pass("board", "LEDs", `channels 0-${hello.leds - 1} acked; check each lit beside the right compartment`)
              : fail("board", "LEDs", `no ack for channel ${refused.join(", ")}`),
          );
        }

        if (!options.beep) lines.push(skip("board", "buzzer", "pass --beep to play one chime"));
        else {
          const ok = await board.buzz("chime");
          lines.push(ok ? pass("board", "buzzer", "chime acked: did you hear it?") : fail("board", "buzzer", "no ack"));
        }

        if (!options.lid) lines.push(skip("board", "lid switch", "pass --lid to test opening and closing"));
        else {
          const before = events.length;
          const toggled = (want: boolean) => (e: BoardEvent): e is Extract<BoardEvent, { t: "lid" }> => isLid(e) && e.open === want;
          const start = events.filter(isLid).at(-1)?.open ?? false;
          say(`Now ${start ? "close" : "open"} the lid, then ${start ? "open" : "close"} it again (20 s each).`);
          const first = await waitForAfter(events, before, toggled(!start), lidWaitMs);
          const second = first ? await waitForAfter(events, events.indexOf(first) + 1, toggled(start), lidWaitMs) : null;
          lines.push(
            first && second
              ? pass("board", "lid switch", `saw ${start ? "closed" : "opened"} then ${start ? "opened" : "closed"}, once each`)
              : fail("board", "lid switch", first ? "saw the first change but not the second" : "saw no change"),
          );
        }

        if (!options.pulse) lines.push(skip("board", "pulse", "pass --pulse to read the MAX30102 for 12 s"));
        else {
          say("Rest a fingertip on the pulse sensor and keep still for 12 s.");
          const started = await board.startPulse();
          const before = events.length;
          await sleep(pulseMs);
          await board.stopPulse();
          const readings = events.slice(before).filter(isPulse);
          const valid = readings.filter((r) => r.quality === "valid" && r.bpm !== null);
          if (!started) lines.push(fail("board", "pulse", "pulse.start refused (sensor missing? check SDA/SCL wiring)"));
          else if (readings.length === 0) lines.push(fail("board", "pulse", "sensor started but sent no readings"));
          else if (valid.length === 0) lines.push(warn("board", "pulse", `${readings.length} readings, none valid (${[...new Set(readings.map((r) => r.quality))].join(", ")})`));
          else lines.push(pass("board", "pulse", `${valid.length} of ${readings.length} readings valid; last ${valid.at(-1)!.bpm} bpm (device reading, not checked against a reference)`));
        }
        return lines;
      } finally {
        await board.close();
      }
    },
  };
}

/** Waits up to `ms` for an event from index `from` on that matches `test`. */
/** Waits up to `ms` for an event, from index `from` on, that matches `test`. */
function waitForAfter<T extends BoardEvent>(events: BoardEvent[], from: number, test: (e: BoardEvent) => e is T, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const found = events.slice(from).find(test);
      if (found) return resolve(found);
      if (Date.now() - started >= ms) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

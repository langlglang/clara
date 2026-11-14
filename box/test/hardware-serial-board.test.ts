import { afterEach, describe, expect, it } from "vitest";
import type { BoardEvent } from "../src/ports.js";
import { SerialBoard, pickBoardPort, type SerialLink } from "../src/hardware/serial-board.js";
import { silentLogger } from "../src/hardware/log.js";
import { FakePort, goodBoard, settle } from "./hardware-fake-port.js";

const boards: SerialBoard[] = [];

function makeBoard(ports: Array<FakePort | null>, options: { heartbeatMs?: number; ackTimeoutMs?: number } = {}) {
  const opened: FakePort[] = [];
  let next = 0;
  const board = new SerialBoard({
    connect: async () => {
      const port = next < ports.length ? ports[next++] : null;
      if (!port) return null;
      opened.push(port);
      return port.link(`/dev/fake${next}`) satisfies SerialLink;
    },
    log: silentLogger,
    ackTimeoutMs: options.ackTimeoutMs ?? 50,
    reconnectMs: 10,
    heartbeatMs: options.heartbeatMs ?? 60_000,
  });
  boards.push(board);
  const events: BoardEvent[] = [];
  board.onEvent((event) => events.push(event));
  return { board, events, opened };
}

afterEach(async () => {
  for (const board of boards.splice(0)) await board.close();
});

describe("SerialBoard", () => {
  it("pings on open, reports connected on hello, then the lid and mount", async () => {
    const port = new FakePort();
    port.responder = goodBoard({ leds: 8 });
    const { board, events } = makeBoard([port]);
    expect(await board.start()).toBe(true);
    await settle();
    expect(port.lines[0]).toEqual({ t: "ping", id: 1 });
    expect(events).toEqual([
      { type: "connected", firmware: "clara-0.2.0", leds: 8 },
      { t: "lid", open: false, seq: 0 },
      { t: "mount", on_wall: true, seq: 1 },
    ]);
    expect(board.connected).toBe(true);
    expect(board.ledCount).toBe(8);
  });

  it("sends contract commands and resolves with the ack", async () => {
    const port = new FakePort();
    port.responder = goodBoard();
    const { board } = makeBoard([port]);
    await board.start();
    await settle();
    expect(await board.lightCompartment(2, 5000, "blink")).toBe(true);
    expect(await board.clearLights()).toBe(true);
    expect(await board.rhythm(110)).toBe(true);
    expect(await board.buzz("chime")).toBe(true);
    expect(await board.startPulse()).toBe(true);
    expect(await board.stopPulse()).toBe(true);
    expect(port.lines.slice(1)).toEqual([
      { t: "led", id: 2, ch: 2, ms: 5000, mode: "blink" },
      { t: "led", id: 3, ch: -1, ms: 0, mode: "solid" },
      { t: "rhythm", id: 4, bpm: 110 },
      { t: "buzz", id: 5, pattern: "chime" },
      { t: "pulse.start", id: 6 },
      { t: "pulse.stop", id: 7 },
    ]);
  });

  it("returns a fresh correlated raw sensor result from the board", async () => {
    const port = new FakePort();
    const answer = goodBoard();
    port.responder = (command, p) => {
      answer(command, p);
      if (command.t === "sensor.read") p.send({
        t: "sensor.raw", id: command.id, seq: 2, sample_seq: 42,
        sampled_uptime_ms: 9000, red: 110234, ir: 128765, quality: "valid",
      });
    };
    const { board, events } = makeBoard([port]);
    await board.start();
    await settle();
    const reading = await board.readSensorRaw();
    expect(port.lines.at(-1)).toEqual({ t: "sensor.read", id: 2 });
    expect(reading).toMatchObject({ id: 2, sample_seq: 42, red: 110234, ir: 128765, quality: "valid" });
    expect(events.at(-1)).toEqual(reading);
  });

  it("does not return malformed, unavailable or unrequested raw values", async () => {
    const port = new FakePort();
    const answer = goodBoard();
    port.responder = (command, p) => {
      answer(command, p);
      if (command.t === "sensor.read") p.send({
        t: "sensor.raw", id: command.id, seq: 2, sample_seq: 42,
        sampled_uptime_ms: 0, red: null, ir: null, quality: "unavailable",
      });
    };
    const { board, events } = makeBoard([port]);
    await board.start();
    await settle();
    expect(await board.readSensorRaw()).toBeNull();
    port.send({ t: "sensor.raw", id: 999, seq: 3, sample_seq: 43, sampled_uptime_ms: 9000, red: 1, ir: 1, quality: "valid" });
    await settle();
    expect(events.filter((event) => "t" in event && event.t === "sensor.raw")).toHaveLength(1);
  });

  it("resolves false on a nack, on silence, and for commands outside the contract", async () => {
    const port = new FakePort();
    const answer = goodBoard();
    port.responder = (command, p) => {
      if (command.t === "led") p.send({ t: "ack", id: command.id, ok: false, err: "lid_closed" });
      else if (command.t === "buzz") return; // silence
      else answer(command, p);
    };
    const { board } = makeBoard([port]);
    await board.start();
    await settle();
    expect(await board.lightCompartment(1, 1000)).toBe(false);
    expect(await board.buzz("alert")).toBe(false);
    const before = port.lines.length;
    expect(await board.lightCompartment(9, 1000)).toBe(false); // the board has 6 LEDs
    expect(await board.rhythm(500)).toBe(false); // over the contract's 200
    expect(await board.lightCompartment(0, 120_000)).toBe(false); // lease over 60 s
    expect(port.lines.length).toBe(before);
  });

  it("does not pass on a re-reported lid state, and ignores lines before hello", async () => {
    const port = new FakePort();
    const { board, events } = makeBoard([port]);
    await board.start();
    port.send({ t: "lid", open: true, seq: 5 });
    await settle();
    expect(events.filter((e) => "t" in e)).toEqual([]);
    port.send({ t: "hello", proto: "1.1", fw: "x", boot: "b", leds: 6 });
    port.send({ t: "lid", open: true, seq: 6 });
    port.send({ t: "lid", open: true, seq: 7 });
    port.send({ t: "pulse", bpm: null, quality: "unavailable", seq: 8 });
    port.send({ t: "lid", open: false, seq: 9 });
    await settle();
    expect(events.filter((e) => "t" in e)).toEqual([
      { t: "lid", open: true, seq: 6 },
      { t: "pulse", bpm: null, quality: "unavailable", seq: 8 },
      { t: "lid", open: false, seq: 9 },
    ]);
  });

  it("reports connected again when the board restarts with a new boot id", async () => {
    const port = new FakePort();
    port.responder = goodBoard({ boot: "b1" });
    const { board, events } = makeBoard([port]);
    await board.start();
    await settle();
    port.send({ t: "hello", proto: "1.1", fw: "clara-0.2.0", boot: "b1", leds: 6 }); // same boot: nothing new
    port.send({ t: "hello", proto: "1.1", fw: "clara-0.2.0", boot: "b2", leds: 6 });
    await settle();
    expect(events.filter((e) => "type" in e && e.type === "connected")).toHaveLength(2);
  });

  it("fails waiting commands on unplug, reports disconnected, and reconnects", async () => {
    const first = new FakePort();
    first.responder = (command, p) => {
      if (command.t === "ping") goodBoard()(command, p);
    };
    const second = new FakePort();
    second.responder = goodBoard({ boot: "b2", lidOpen: true });
    const { board, events } = makeBoard([first, second], { ackTimeoutMs: 5000 });
    await board.start();
    await settle();
    const waiting = board.lightCompartment(0, 1000);
    first.destroy();
    expect(await waiting).toBe(false);
    expect(events).toContainEqual({ type: "disconnected", reason: "port closed (unplugged?)" });
    for (let i = 0; i < 20 && !board.connected; i += 1) await new Promise((r) => setTimeout(r, 10));
    await settle();
    expect(board.connected).toBe(true);
    expect(events.at(-3)).toEqual({ type: "connected", firmware: "clara-0.2.0", leds: 6 });
    expect(events.at(-1)).toEqual({ t: "mount", on_wall: true, seq: 1 });
    expect(events.at(-2)).toEqual({ t: "lid", open: true, seq: 0 });
    expect(await board.buzz("off")).toBe(true);
  });

  it("drops a port whose board stops answering pings", async () => {
    const port = new FakePort();
    let alive = true;
    const answer = goodBoard();
    port.responder = (command, p) => {
      if (alive) answer(command, p);
    };
    const { board, events } = makeBoard([port], { heartbeatMs: 20, ackTimeoutMs: 10 });
    await board.start();
    await settle();
    alive = false;
    for (let i = 0; i < 30 && board.connected; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(board.connected).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "disconnected", reason: "no answer to 2 pings" });
    expect(port.destroyed).toBe(true);
  });

  it("reports disconnected once when no port is found, and resolves commands false", async () => {
    const { board, events } = makeBoard([]);
    expect(await board.start()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toEqual([{ type: "disconnected", reason: "no ESP32 serial port" }]);
    expect(await board.lightCompartment(0, 100)).toBe(false);
  });

  it("replays the link and switch state to a late listener", async () => {
    const port = new FakePort();
    port.responder = goodBoard({ lidOpen: true });
    const { board } = makeBoard([port]);
    await board.start();
    await settle();
    const late: BoardEvent[] = [];
    board.onEvent((event) => late.push(event));
    await settle(1);
    expect(late).toEqual([
      { type: "connected", firmware: "clara-0.2.0", leds: 6 },
      { t: "lid", open: true, seq: 0 },
      { t: "mount", on_wall: true, seq: 1 },
    ]);
  });
});

describe("pickBoardPort", () => {
  const ports = [
    { path: "/dev/ttyAMA10" },
    { path: "/dev/ttyACM0", vendorId: "1546", manufacturer: "u-blox AG" }, // the GPS
    { path: "/dev/ttyUSB0", vendorId: "10C4", productId: "ea60", pnpId: "usb-Silicon_Labs_CP2102N_abc-if00-port0" },
  ];

  it("picks the ESP32 bridge by vendor and prefers its by-id link on Linux", () => {
    expect(pickBoardPort(ports, "linux", () => true)?.path).toBe("/dev/serial/by-id/usb-Silicon_Labs_CP2102N_abc-if00-port0");
    expect(pickBoardPort(ports, "linux", () => false)?.path).toBe("/dev/ttyUSB0");
    expect(pickBoardPort([{ path: "COM5", vendorId: "1A86", manufacturer: "wch.cn" }], "win32")?.path).toBe("COM5");
  });

  it("finds nothing when only other devices are attached", () => {
    expect(pickBoardPort(ports.slice(0, 2), "linux")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardEvent } from "../src/ports.js";
import { SerialBoard, SimBoard, openBoard, silentLogger } from "../src/hardware/index.js";
import { FakePort, goodBoard, settle } from "./hardware-fake-port.js";

const open: Board[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const board of open.splice(0)) await board.close();
});

function sim(options: ConstructorParameters<typeof SimBoard>[0] = {}) {
  const board = new SimBoard({ log: silentLogger, ...options });
  open.push(board);
  const events: BoardEvent[] = [];
  board.onEvent((event) => events.push(event));
  return { board, events };
}

describe("SimBoard", () => {
  it("starts connected, reports switch changes once, and records commands", async () => {
    const { board, events } = sim({ leds: 8 });
    await settle(1);
    board.setLid(true);
    board.setLid(true);
    board.setMount(false);
    expect(events).toEqual([
      { type: "connected", firmware: "sim-0.1.0", leds: 8 },
      { t: "lid", open: false, seq: 0 },
      { t: "mount", on_wall: true, seq: 1 },
      { t: "lid", open: true, seq: 2 },
      { t: "mount", on_wall: false, seq: 3 },
    ]);
    expect(await board.lightCompartment(3, 1000, "pulse")).toBe(true);
    expect(await board.buzz("chime")).toBe(true);
    expect(board.history).toEqual([
      { t: "led", ch: 3, ms: 1000, mode: "pulse" },
      { t: "buzz", pattern: "chime" },
    ]);
    expect(await board.lightCompartment(8, 1000)).toBe(false);
  });

  it("lights one compartment at a time, ends the lease, and clears on lid close", async () => {
    vi.useFakeTimers();
    const { board } = sim({ lidOpen: true });
    await board.lightCompartment(1, 1000);
    await board.lightCompartment(2, 1000);
    expect(board.litChannel).toBe(2);
    vi.advanceTimersByTime(1001);
    expect(board.litChannel).toBeNull();
    await board.lightCompartment(4, 5000);
    await board.rhythm(110);
    board.setLid(false);
    expect(board.litChannel).toBeNull();
    expect(board.rhythmRunning).toBe(0);
  });

  it("never reports a pulse number unless the reading is valid", async () => {
    vi.useFakeTimers();
    const { board, events } = sim({ pulseIntervalMs: 100 });
    await board.startPulse();
    vi.advanceTimersByTime(100);
    board.setPulse(72, "suspect");
    vi.advanceTimersByTime(100);
    board.setPulse(72);
    vi.advanceTimersByTime(100);
    await board.stopPulse();
    vi.advanceTimersByTime(500);
    expect(events.filter((e) => "t" in e && e.t === "pulse").map((e) => ("t" in e && e.t === "pulse" ? [e.bpm, e.quality] : null))).toEqual([
      [null, "unavailable"],
      [null, "suspect"],
      [72, "valid"],
    ]);
  });

  it("refuses commands while unplugged", async () => {
    const { board, events } = sim();
    board.disconnect();
    expect(await board.lightCompartment(0, 100)).toBe(false);
    board.reconnect();
    expect(await board.lightCompartment(0, 100)).toBe(true);
    expect(events.filter((e) => "type" in e).map((e) => ("type" in e ? e.type : ""))).toEqual(["connected", "disconnected", "connected"]);
  });
});

describe("openBoard", () => {
  it("uses the simulator when asked", async () => {
    const board = await openBoard({ sim: true, log: silentLogger, simOptions: { log: silentLogger } });
    open.push(board);
    expect(board.simulated).toBe(true);
  });

  it("falls back to the simulator when no port is found", async () => {
    const board = await openBoard({ log: silentLogger, connect: async () => null, fallbackToSim: true, simOptions: { log: silentLogger } });
    open.push(board);
    expect(board.simulated).toBe(true);
  });

  it("keeps a real board that reports the missing ESP32 when falling back is off", async () => {
    const board = await openBoard({ log: silentLogger, connect: async () => null, fallbackToSim: false });
    open.push(board);
    expect(board).toBeInstanceOf(SerialBoard);
    expect(board.simulated).toBe(false);
    const events: BoardEvent[] = [];
    board.onEvent((event) => events.push(event));
    await settle(1);
    expect(events).toEqual([{ type: "disconnected", reason: "no ESP32 serial port" }]);
  });

  it("opens the real board when a port answers", async () => {
    const port = new FakePort();
    port.responder = goodBoard();
    const board = await openBoard({ log: silentLogger, connect: async () => port.link() });
    open.push(board);
    expect(board.simulated).toBe(false);
  });
});

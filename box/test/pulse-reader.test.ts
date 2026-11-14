import { describe, expect, it } from "vitest";
import type { Board, BoardEvent } from "../src/ports.js";
import { PulseReader } from "../src/sensors/pulse-reader.js";

function fakeBoard(simulated = false) {
  let listener: (event: BoardEvent) => void = () => {};
  let started = 0;
  let stopped = 0;
  const board: Pick<Board, "simulated" | "onEvent" | "startPulse" | "stopPulse"> = {
    simulated,
    onEvent: (fn) => { listener = fn; },
    startPulse: async () => { started++; return true; },
    stopPulse: async () => { stopped++; return true; },
  };
  return { board, send: (event: BoardEvent) => listener(event), counts: () => ({ started, stopped }) };
}

describe("PulseReader", () => {
  it("returns only a new valid hardware event after starting, with source and receipt time", async () => {
    const h = fakeBoard();
    const reader = new PulseReader(h.board);
    h.send({ t: "pulse", bpm: 71, quality: "valid", seq: 1 }); // stale, before request
    const pending = reader.read(new AbortController().signal, 100);
    await Promise.resolve();
    h.send({ t: "pulse", bpm: null, quality: "suspect", seq: 2 });
    h.send({ t: "pulse", bpm: null, quality: "unavailable", seq: 3 });
    h.send({ t: "pulse", bpm: null, quality: "unavailable", seq: 4 });
    h.send({ t: "pulse", bpm: 73, quality: "valid", seq: 5 });
    const result = await pending;
    expect(result).toMatchObject({ bpm: 73, quality: "valid", source: "MAX30102 via ESP32", sequence: 5 });
    expect(Date.parse(result!.observedAt)).toBeGreaterThan(0);
    expect(h.counts()).toEqual({ started: 1, stopped: 1 });
  });

  it("returns unavailable without a number when no finger is present", async () => {
    const h = fakeBoard();
    const reader = new PulseReader(h.board);
    const pending = reader.read(new AbortController().signal, 20);
    await Promise.resolve();
    h.send({ t: "pulse", bpm: null, quality: "unavailable", seq: 1 });
    h.send({ t: "pulse", bpm: null, quality: "unavailable", seq: 2 });
    expect(await pending).toMatchObject({ bpm: null, quality: "unavailable", sequence: 2 });
    expect(h.counts().stopped).toBe(1);
  });

  it("stops on cancel, refuses simultaneous requests, and never reads a simulated board", async () => {
    const h = fakeBoard();
    const reader = new PulseReader(h.board);
    const controller = new AbortController();
    const pending = reader.read(controller.signal, 100);
    expect(await reader.read(new AbortController().signal, 100)).toBeNull();
    controller.abort();
    expect(await pending).toBeNull();
    expect(h.counts()).toEqual({ started: 1, stopped: 1 });
    expect(await new PulseReader(fakeBoard(true).board).read(new AbortController().signal)).toBeNull();
  });

  it("does not return a number after a disconnect or a suspect-only timeout", async () => {
    const h = fakeBoard();
    const reader = new PulseReader(h.board);
    const pending = reader.read(new AbortController().signal, 20);
    await Promise.resolve();
    h.send({ t: "pulse", bpm: null, quality: "suspect", seq: 4 });
    expect(await pending).toMatchObject({ bpm: null, quality: "suspect", sequence: 4 });
    const disconnected = reader.read(new AbortController().signal, 100);
    await Promise.resolve();
    h.send({ type: "disconnected", reason: "unplugged" });
    expect(await disconnected).toBeNull();
  });
});

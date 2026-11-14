import { describe, expect, it } from "vitest";
import { boxCheck, parseArgs, type CheckArgs } from "../src/check/index.js";
import { alsaNames, pcmLevel } from "../src/check/audio.js";
import type { BoardSource } from "../src/check/board.js";
import type { RunResult, Runner } from "../src/check/core.js";
import { SerialBoard, silentLogger } from "../src/hardware/index.js";
import { FakePort, goodBoard } from "./hardware-fake-port.js";

const ok = (stdout: Buffer | string): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: "", missing: false, timedOut: false, ms: 5 });

function fakeBoards(port: FakePort): BoardSource {
  return {
    listPorts: async () => [{ path: "/dev/ttyUSB0", vendorId: "10c4", productId: "ea60", manufacturer: "Silicon Labs" }],
    async open() {
      const board = new SerialBoard({ connect: async () => port.link("/dev/ttyUSB0"), log: silentLogger, ackTimeoutMs: 100 });
      await board.start();
      return { board, id: "/dev/ttyUSB0" };
    },
  };
}

describe("check CLI", () => {
  it("parses its flags", () => {
    expect(parseArgs(["--port", "/dev/x", "--leds"])).toMatchObject({ port: "/dev/x", leds: true, beep: false });
    expect(parseArgs(["--all"])).toMatchObject({ leds: true, beep: true, lid: true, pulse: true, sound: true });
    expect(parseArgs(["--port"])).toEqual({ error: "--port needs a path" });
    expect(parseArgs(["--fly"])).toEqual({ error: "unknown option --fly" });
  });

  it("checks the ports, the board, every LED channel, the buzzer, mic and speaker", async () => {
    const port = new FakePort();
    port.responder = goodBoard({ leds: 2, lidOpen: true });
    const pcm = Buffer.alloc(32_000);
    pcm.writeInt16LE(1200, 100);
    const run: Runner = async (command, args) => {
      if (command === "arecord") return ok(pcm);
      if (command === "aplay" && args[0] === "-L") return ok("null\n    Discard all samples\ndefault\n    Default device\n");
      return ok("");
    };
    const out: string[] = [];
    const args = { ...(parseArgs(["--leds", "--beep"]) as CheckArgs) };
    const code = await boxCheck(args, { run, platform: "linux", env: {}, boards: fakeBoards(port), write: (l) => out.push(l) });
    const text = out.join("\n");
    expect(text).toMatch(/PASS\s+serial\s+chosen\s+\/dev\/ttyUSB0/);
    expect(text).toMatch(/PASS\s+board\s+hello .*2 LED channels/);
    expect(text).toMatch(/PASS\s+board\s+lid\s+reads open/);
    expect(text).toMatch(/PASS\s+board\s+LEDs\s+channels 0-1 acked/);
    expect(text).toMatch(/PASS\s+board\s+buzzer/);
    expect(text).toMatch(/PASS\s+audio\s+microphone\s+default: 1.0 s recorded, peak 1200/);
    expect(text).toMatch(/PASS\s+audio\s+speaker/);
    expect(code).toBe(0);
    expect(port.lines.filter((l) => l.t === "led").map((l) => l.ch)).toEqual([0, 1, -1, -1]); // the last clear is close() leaving nothing lit
  }, 10_000);

  it("fails clearly when the board never says hello", async () => {
    const port = new FakePort();
    const out: string[] = [];
    const args = parseArgs(["--no-audio"]) as CheckArgs;
    const code = await boxCheck(args, { run: async () => ok(""), platform: "linux", env: {}, boards: fakeBoards(port), write: (l) => out.push(l) });
    expect(out.join("\n")).toMatch(/FAIL\s+board\s+hello\s+\/dev\/ttyUSB0: no hello within 5 s/);
    expect(code).toBe(1);
  }, 10_000);

  it("reads levels and ALSA names", () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(-300, 2);
    expect(pcmLevel(pcm).peak).toBe(300);
    expect(alsaNames("default\n    x\nplughw:CARD=Speaker,DEV=0\n")).toEqual(["default", "plughw:CARD=Speaker,DEV=0"]);
  });
});

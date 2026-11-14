import { describe, expect, it } from "vitest";
import { SERIAL_MAX_LINE } from "@clara/contracts";
import { LineReader, type LineResult } from "../src/hardware/line-reader.js";

function makeReader() {
  const results: LineResult[] = [];
  return { results, reader: new LineReader((result) => results.push(result)) };
}

describe("LineReader", () => {
  it("joins a line split across chunks and splits several lines in one chunk", () => {
    const { results, reader } = makeReader();
    reader.push(Buffer.from('{"t":"lid","op'));
    reader.push(Buffer.from('en":true,"seq":1}\n{"t":"ack","id":3,"ok":true}\n{"t":"mount",'));
    expect(results).toEqual([
      { ok: true, message: { t: "lid", open: true, seq: 1 } },
      { ok: true, message: { t: "ack", id: 3, ok: true } },
    ]);
    expect(reader.buffered).toBeGreaterThan(0);
  });

  it("accepts CRLF and skips blank lines", () => {
    const { results, reader } = makeReader();
    reader.push(Buffer.from('\r\n\n{"t":"ack","id":1,"ok":false,"err":"lid_closed"}\r\n'));
    expect(results).toEqual([{ ok: true, message: { t: "ack", id: 1, ok: false, err: "lid_closed" } }]);
  });

  it("reports an oversize line once, drops it, and resyncs at the next newline", () => {
    const { results, reader } = makeReader();
    reader.push(Buffer.alloc(SERIAL_MAX_LINE + 10, 0x61));
    reader.push(Buffer.alloc(500, 0x61));
    reader.push(Buffer.from('aaa\n{"t":"ack","id":2,"ok":true}\n'));
    expect(results.map((r) => (r.ok ? r.message.t : r.problem))).toEqual(["oversize", "ack"]);
    expect(reader.buffered).toBe(0);
  });

  it("accepts a line of exactly the maximum length", () => {
    const { results, reader } = makeReader();
    const base = '{"t":"ack","id":1,"ok":true}';
    const line = base + " ".repeat(SERIAL_MAX_LINE - base.length - 1) + "\n";
    expect(Buffer.byteLength(line)).toBe(SERIAL_MAX_LINE);
    reader.push(Buffer.from(line));
    expect(results).toEqual([{ ok: true, message: { t: "ack", id: 1, ok: true } }]);
  });

  it("refuses boot-loader garbage, non-UTF-8 and lines outside the contract", () => {
    const { results, reader } = makeReader();
    reader.push(Buffer.from("ets Jun  8 2016 00:22:57\n"));
    reader.push(Buffer.from([0xff, 0xfe, 0x0a]));
    reader.push(Buffer.from('{"t":"pulse","bpm":72,"quality":"great","seq":1}\n'));
    reader.push(Buffer.from('{"t":"lid","open":true,"seq":1,"extra":1}\n'));
    reader.push(Buffer.from('{"t":"pulse","bpm":null,"quality":"unavailable","seq":2}\n'));
    expect(results.map((r) => (r.ok ? "ok" : r.problem))).toEqual(["malformed", "malformed", "invalid", "invalid", "ok"]);
  });
});

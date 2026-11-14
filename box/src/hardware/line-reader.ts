// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/serial/lineReader.ts.
import { FromBoardSchema, SERIAL_MAX_LINE, type FromBoard } from "@clara/contracts";

export type LineProblem = "oversize" | "malformed" | "invalid";

export type LineResult = { ok: true; message: FromBoard } | { ok: false; problem: LineProblem; detail: string };

/** One line of text (without its newline) → a validated board message, or why not. */
export function parseBoardLine(text: string): LineResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "malformed", detail: "Not JSON." };
  }
  const parsed = FromBoardSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: "invalid", detail: issue ? `${issue.path.join(".") || "(line)"}: ${issue.message}` : "Does not match the contract." };
  }
  return { ok: true, message: parsed.data };
}

/**
 * Splits a serial byte stream into JSON lines and validates each against `FromBoardSchema`.
 *
 * The buffer never holds more than one line's worth of bytes (SERIAL_MAX_LINE counting the `\n`). A longer
 * line is reported once as `oversize`, dropped up to its newline, and reading resumes at the next line.
 * Invalid UTF-8 is `malformed`. Blank lines and a trailing `\r` are ignored. The ESP32's ROM bootloader prints
 * at 74880 baud on reset, which arrives here as garbage: that is `malformed` and simply skipped.
 */
export class LineReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private discarding = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly onResult: (result: LineResult) => void) {}

  push(data: Buffer): void {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) {
        this.append(data.subarray(start));
        return;
      }
      this.finish(data.subarray(start, newline + 1));
      start = newline + 1;
    }
  }

  /** Bytes held while waiting for a newline; never more than SERIAL_MAX_LINE - 1. */
  get buffered(): number {
    return this.length;
  }

  reset(): void {
    this.chunks = [];
    this.length = 0;
    this.discarding = false;
  }

  private append(part: Buffer): void {
    if (this.discarding || part.length === 0) return;
    if (this.length + part.length > SERIAL_MAX_LINE - 1) {
      this.clear();
      this.discarding = true;
      this.onResult({ ok: false, problem: "oversize", detail: `Longer than ${SERIAL_MAX_LINE} bytes.` });
      return;
    }
    this.chunks.push(Buffer.from(part));
    this.length += part.length;
  }

  private finish(lastPart: Buffer): void {
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    if (this.length + lastPart.length > SERIAL_MAX_LINE) {
      this.clear();
      this.onResult({ ok: false, problem: "oversize", detail: `Longer than ${SERIAL_MAX_LINE} bytes.` });
      return;
    }
    const bytes = Buffer.concat([...this.chunks, lastPart]);
    this.clear();
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      this.onResult({ ok: false, problem: "malformed", detail: "Not UTF-8." });
      return;
    }
    text = text.replace(/\r?\n$/, "");
    if (text.trim() === "") return;
    this.onResult(parseBoardLine(text));
  }

  private clear(): void {
    this.chunks = [];
    this.length = 0;
  }
}

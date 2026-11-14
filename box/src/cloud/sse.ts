/** One Server-Sent Events message: its `event` name (default "message") and its joined `data` lines. */
export interface SseMessage {
  event: string;
  data: string;
}

/** Bounds a stream that never sends a blank line, so a broken server can't grow memory without end. */
export const MAX_SSE_BUFFER = 256 * 1024;

/**
 * An incremental parser for text/event-stream (the subset the server uses: `event:`, `data:`, comments).
 * Feed it decoded text in any chunking; it returns the complete messages so far.
 */
export class SseParser {
  private buffer = "";

  feed(text: string): SseMessage[] {
    this.buffer += text.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      if (end > MAX_SSE_BUFFER) throw new Error("event stream message too large");
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) out.push({ event, data: data.join("\n") });
    }
    if (this.buffer.length > MAX_SSE_BUFFER) throw new Error("event stream message too large");
    return out;
  }
}

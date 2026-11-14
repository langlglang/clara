/** Small helpers shared by the API routes: JSON answers, a JSON error envelope, body parsing and SSE. */

export type ErrorCode = "bad_request" | "not_found" | "forbidden" | "conflict" | "server_error";

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const fail = (status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Response =>
  json({ error: { code, message, ...extra } }, status);

/** The request's JSON body, or a 400 Response when it isn't JSON. */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const text = await req.text().catch(() => null);
  if (text === null) return { ok: false, response: fail(400, "bad_request", "Couldn't read the request body.") };
  if (text.trim() === "") return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: fail(400, "bad_request", "The body isn't JSON.") };
  }
}

/** Zod's issues, short enough for a JSON error. */
export const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.slice(0, 10).map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`);

export interface SseWriter {
  /** One message; `event` omitted means the default "message". */
  send(data: unknown, event?: string): void;
  /** A comment line (keep-alive). */
  comment(text: string): void;
}

export const KEEPALIVE_MS = 15_000;

/**
 * A Server-Sent Events response. `setup` subscribes and returns its cleanup, which runs when the client goes
 * away (request aborted or stream cancelled). A comment goes out every 15 s so proxies and the box's idle
 * deadline (45 s) see the line is alive.
 */
export function sseResponse(req: Request, setup: (out: SseWriter) => () => void): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        cleanup?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      const out: SseWriter = {
        send: (data, event) => write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`),
        comment: (text) => write(`: ${text.replace(/\n/g, " ")}\n\n`),
      };
      write("retry: 3000\n\n");
      out.comment("connected");
      cleanup = setup(out);
      timer = setInterval(() => out.comment("keep-alive"), KEEPALIVE_MS);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

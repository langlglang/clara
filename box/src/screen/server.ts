// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/screen/server.ts. Kept: loopback only, Host
// and Origin checks, a per-boot token for the stream and the POSTs, SSE with keepalives and a buffer cap, and
// "the box carries on without its screen" when it can't start. Dropped: the lift hold control, map tiles and
// the bundled React page (Clara's page is plain HTML/CSS/JS with no build step).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { ScreenPressSchema, type ScreenPress, type ScreenView } from "./view.js";

/**
 * The box screen's local server: the kiosk page, its two files, step pictures from content/, a Server-Sent
 * Events stream of `ScreenView` (GET /screen/events) and the page's presses (POST /screen/press), on
 * 127.0.0.1 only. The page needs no token; the stream and the POST do, and only the page this server sends
 * knows it (no CORS headers are ever sent, so another site can't read the page).
 */

export const DEFAULT_SCREEN_PORT = 8787;

export interface ScreenServerOptions {
  port: number;
  /** box/public: index.html, app.js, style.css. */
  publicDir: string;
  /** The repo's content/ folder, for step pictures. Null serves none. */
  contentDir?: string | null;
  current: () => ScreenView | null;
  onPress?: (press: ScreenPress) => void;
  token?: string;
  log?: (line: string) => void;
}

export interface ScreenServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  publish(view: ScreenView): void;
  clients(): number;
  close(): Promise<void>;
}

const PAGE_FILES: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  // Bundled IBM Plex (SIL OFL), so the Field Kit look works on an offline Pi.
  "fonts/IBMPlexMono-Medium-latin.woff2": "font/woff2",
  "fonts/IBMPlexMono-Bold-latin.woff2": "font/woff2",
  "fonts/IBMPlexSans-Variable-latin.woff2": "font/woff2",
};
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  // Short silent step clips.
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};
const MAX_BODY_BYTES = 4096;
const MAX_STREAMS = 8;
const KEEPALIVE_MS = 15_000;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 32;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
}

/** Why a request is refused, or null when it may go on (the token is checked per route). */
export function refusal(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } }, port: number): string | null {
  if (!isLoopback(req.socket.remoteAddress)) return "not loopback";
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? "")) return "wrong host";
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return "wrong origin";
  return null;
}

function tokenMatches(expected: Buffer, given: string | string[] | null | undefined): boolean {
  if (typeof given !== "string") return false;
  const buffer = Buffer.from(given);
  return buffer.length === expected.length && timingSafeEqual(buffer, expected);
}

function send(res: ServerResponse, status: number, body: string | Buffer = "", type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => done(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(null));
  });
}

/** A path under `root`, or null when the request tries to leave it or names something that isn't an image. */
export function contentPath(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0") || !IMAGE_TYPES[extname(rel).toLowerCase()]) return null;
  const base = resolve(root);
  const full = resolve(base, `.${rel.startsWith("/") ? "" : "/"}${rel}`);
  return full.startsWith(base + sep) ? full : null;
}

/** Starts the server, or logs one line and returns null (port taken, page files missing): the box carries on. */
export async function startScreenServer(options: ScreenServerOptions): Promise<ScreenServer | null> {
  const log = options.log ?? (() => {});
  let template: string;
  const files = new Map<string, Buffer>();
  try {
    template = readFileSync(join(options.publicDir, "index.html"), "utf8");
    for (const name of Object.keys(PAGE_FILES)) files.set(name, readFileSync(join(options.publicDir, name)));
  } catch (error) {
    log(`screen not started: its page files are missing (${(error as Error).message.slice(0, 120)})`);
    return null;
  }
  const token = options.token ?? randomBytes(32).toString("base64url");
  const expected = Buffer.from(token);
  // The token is base64url, so it needs no escaping in an attribute.
  const html = template.replace("__SCREEN_TOKEN__", token);
  const streams = new Set<ServerResponse>();
  let actualPort = options.port;
  const frame = (view: ScreenView) => `event: view\ndata: ${JSON.stringify(view)}\n\n`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const refused = refusal(req, actualPort);
    if (refused) return send(res, refused === "not loopback" ? 403 : 421, "Refused.");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(res, 200, html, "text/html; charset=utf-8");
    if (req.method === "GET" && path.startsWith("/screen/assets/")) {
      const name = path.slice("/screen/assets/".length);
      const body = files.get(name);
      if (!body) return send(res, 404, "Not found.");
      return send(res, 200, body, PAGE_FILES[name]!);
    }
    if (req.method === "GET" && path.startsWith("/content/")) {
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, "Refused.");
      const file = options.contentDir ? contentPath(options.contentDir, path.slice("/content".length)) : null;
      if (!file) return send(res, 404, "Not found.");
      try {
        const body = await readFile(file);
        const type = IMAGE_TYPES[extname(file).toLowerCase()]!;
        // Video players ask for byte ranges; answer one simple range, else the whole file.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (range && type.startsWith("video/") && (range[1] || range[2])) {
          const size = body.length;
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start >= size || start > end) {
            res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${size}` });
            return res.end();
          }
          const part = body.subarray(start, end + 1);
          res.writeHead(206, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": part.length, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" });
          return res.end(part);
        }
        return send(res, 200, body, type);
      } catch {
        return send(res, 404, "Not found.");
      }
    }
    // 204: the token is still good (reconnect). 403: the service restarted (reload for the new token).
    if (req.method === "GET" && path === "/screen/check") {
      if (!tokenMatches(expected, url.searchParams.get("token"))) return send(res, 403, "Refused.");
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    if (req.method === "GET" && path === "/screen/events") {
      if (!tokenMatches(expected, url.searchParams.get("token"))) return send(res, 403, "Refused.");
      if (streams.size >= MAX_STREAMS) return send(res, 503, "Too many screens.");
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 1000\n\n");
      const current = options.current();
      if (current) res.write(frame(current));
      streams.add(res);
      req.socket.setNoDelay(true);
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
      res.on("close", () => {
        clearInterval(keepalive);
        streams.delete(res);
      });
      return;
    }
    if (req.method === "POST" && path === "/screen/press") {
      if (!tokenMatches(expected, req.headers["x-screen-token"])) return send(res, 403, "Refused.");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "JSON only.");
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, "Too large.");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return send(res, 400, "Not JSON.");
      }
      const press = ScreenPressSchema.safeParse(json);
      if (!press.success) return send(res, 400, "Not a press.");
      try {
        options.onPress?.(press.data);
      } catch (error) {
        log(`screen press failed: ${(error as Error).message}`);
        return send(res, 500, "Error.");
      }
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    return send(res, 404, "Not found.");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`screen request failed: ${(error as Error)?.name ?? "unknown"}`);
      if (!res.headersSent) send(res, 500, "Error.");
      else res.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = MAX_CONNECTIONS;

  const listening = await new Promise<boolean>((done) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      log(error.code === "EADDRINUSE" ? `screen not started: port ${options.port} is taken` : `screen not started (${error.code ?? "unknown"})`);
      done(false);
    });
    server.listen(options.port, "127.0.0.1", () => done(true));
  });
  if (!listening) return null;
  const address = server.address();
  if (address && typeof address === "object") actualPort = address.port;
  server.on("error", (error: NodeJS.ErrnoException) => log(`screen server error (${error.code ?? "unknown"})`));

  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    token,
    publish(view) {
      const data = frame(view);
      for (const res of streams) {
        try {
          if (res.writableLength > MAX_BUFFERED_BYTES) res.destroy();
          else res.write(data);
        } catch {
          res.destroy();
        }
      }
    },
    clients: () => streams.size,
    close: () =>
      new Promise<void>((done) => {
        for (const res of streams) res.destroy();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

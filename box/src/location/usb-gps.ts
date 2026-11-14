import { SerialPort } from "serialport";
import { GpsTracker, type GpsFix, type LocationProvider } from "./gps.js";

const MAX_BUFFER_BYTES = 1024;
const RECONNECT_MS = 2_000;

/** Reads a USB GNSS receiver's NMEA stream locally. No coordinates or raw sentences enter logs. */
export class UsbGpsLocation implements LocationProvider {
  private readonly tracker: GpsTracker;
  private port: SerialPort | null = null;
  private buffer = "";
  private running = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.tracker = new GpsTracker(now);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  current(): GpsFix | null {
    return this.tracker.current();
  }

  async close(): Promise<void> {
    this.running = false;
    this.tracker.invalidate();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const port = this.port;
    this.port = null;
    if (port?.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  private connect(): void {
    if (!this.running || this.port) return;
    const port = new SerialPort({ path: this.path, baudRate: 9600, autoOpen: false });
    this.port = port;
    port.on("data", (data: Buffer) => this.onData(data));
    port.on("error", () => this.disconnected(port, "GPS serial error"));
    port.on("close", () => this.disconnected(port, "GPS disconnected"));
    port.open((error) => {
      if (error) {
        this.disconnected(port, "GPS port unavailable");
        return;
      }
      if (!this.running) {
        port.close(() => {});
        return;
      }
      this.log("GPS receiver connected");
    });
  }

  private disconnected(port: SerialPort, message: string): void {
    if (this.port !== port) return;
    this.port = null;
    this.buffer = "";
    this.tracker.invalidate();
    this.log(message);
    if (port.isOpen) port.close(() => {});
    if (this.running && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, RECONNECT_MS);
    }
  }

  private onData(data: Buffer): void {
    if (!this.running) return;
    this.buffer += data.toString("ascii");
    if (this.buffer.length > MAX_BUFFER_BYTES) this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.tracker.push(line);
    }
  }
}

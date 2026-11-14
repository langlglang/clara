import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";

export type CameraPurpose = "inspect_scene" | "cloud_interpretation";
export interface CameraFrame {
  jpeg: Buffer;
  capturedAt: string;
  device: "USB camera";
  purpose: CameraPurpose;
  consentId: string;
}

type Capture = (signal: AbortSignal) => Promise<Buffer | null>;
const CONSENT_MS = 60_000;
const MAX_JPEG_BYTES = 1_500_000;
const CAMERA_PROMPTS: Record<CameraPurpose, string> = {
  inspect_scene: "May I take one photo with the camera and show it on this screen? The photo stays on this box. Say 'Yes, use the camera' if you agree.",
  cloud_interpretation: "May I take one photo and send it to Clara's cloud to help describe what it shows? Say 'Yes, send the photo' if you agree.",
};

/** Prefer the stable USB identity over a kernel-assigned video number. */
export function defaultCameraDevice(): string {
  try {
    const name = readdirSync("/dev/v4l/by-id").sort().find((entry) => entry.includes("Innomaker") && entry.endsWith("video-index0"));
    if (name && existsSync(`/dev/v4l/by-id/${name}`)) return `/dev/v4l/by-id/${name}`;
  } catch { /* The by-id directory is absent on development machines. */ }
  return "/dev/video0";
}

/** One frame in memory. v4l2-ctl is available on the Pi; no image is written to disk. */
export function captureUsbJpeg(device: string, signal: AbortSignal): Promise<Buffer | null> {
  if (!/^\/dev\/(video\d+|v4l\/by-id\/[A-Za-z0-9_.-]+)$/.test(device) || signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn("v4l2-ctl", ["-d", device, "--set-fmt-video=width=640,height=480,pixelformat=MJPG", "--stream-mmap=3", "--stream-skip=2", "--stream-count=1", "--stream-to=-"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (jpeg: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      for (const part of chunks) part.fill(0);
      resolve(jpeg);
    };
    const abort = () => { child.kill("SIGTERM"); finish(null); };
    const timer = setTimeout(abort, 4_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (part: Buffer) => {
      if (done) return part.fill(0);
      size += part.length;
      if (size > MAX_JPEG_BYTES) return abort();
      chunks.push(part);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const jpeg = code === 0 ? Buffer.concat(chunks) : null;
      const end = jpeg?.lastIndexOf(Buffer.from([0xff, 0xd9])) ?? -1;
      // This camera appends one zero pad byte after JPEG EOI.
      const valid = jpeg && jpeg.length >= 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 &&
        end >= 2 && jpeg.length - end - 2 <= 16 && jpeg.subarray(end + 2).every((byte) => byte === 0);
      if (!valid) jpeg?.fill(0);
      finish(valid ? jpeg.subarray(0, end + 2) : null);
    });
  });
}

/** Consent is scoped to one open session, one purpose, one photo, and a short expiry. */
export class CameraCapture {
  private pending: { sessionId: string; purpose: CameraPurpose; consentId: string; expiresAt: number; granted: boolean } | null = null;

  constructor(private readonly currentSession: () => string | null, private readonly capture: Capture, private readonly now = Date.now) {}

  requestConsent(sessionId: string, purpose: CameraPurpose): string | null {
    if (this.currentSession() !== sessionId) return null;
    this.pending = { sessionId, purpose, consentId: randomUUID(), expiresAt: this.now() + CONSENT_MS, granted: false };
    return CAMERA_PROMPTS[purpose];
  }

  /** An explicit spoken camera request authorizes one capture and cloud upload in this lid session. */
  grantFromRequest(sessionId: string, heard: string): boolean {
    if (this.currentSession() !== sessionId || /\b(?:do not|don't|dont|never|not|without)\b/i.test(heard) ||
      !/\b(camera|photo|picture)\b/i.test(heard) ||
      !/\b(take|capture|use|look|inspect|check|analy[sz]e|see|show|describe)\b/i.test(heard)) return false;
    this.pending = { sessionId, purpose: "cloud_interpretation", consentId: randomUUID(), expiresAt: this.now() + CONSENT_MS, granted: true };
    return true;
  }

  /** Only an explicit spoken phrase after the question grants one capture. */
  acceptConsent(sessionId: string, purpose: CameraPurpose, heard: string): boolean {
    const pending = this.pending;
    if (!pending || pending.sessionId !== sessionId || pending.purpose !== purpose ||
      this.currentSession() !== sessionId || this.now() > pending.expiresAt) return false;
    const words = heard.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
    if (words === "no" || words === "no thanks" || words === "do not use the camera") {
      this.pending = null;
      return false;
    }
    const accepted = purpose === "inspect_scene"
      ? words === "yes use the camera" || words === "yes you can use the camera"
      : words === "yes send the photo" || words === "yes send the photo to clara";
    if (!accepted) return false;
    pending.granted = true;
    return true;
  }

  async captureOnce(sessionId: string, purpose: CameraPurpose, signal: AbortSignal): Promise<CameraFrame | null> {
    const pending = this.pending;
    if (!pending?.granted || pending.sessionId !== sessionId || pending.purpose !== purpose ||
      this.currentSession() !== sessionId || this.now() > pending.expiresAt || signal.aborted) return null;
    this.pending = null; // A failed photo still consumes consent; another attempt needs a new grant.
    const jpeg = await this.capture(signal).catch(() => null);
    if (!jpeg || signal.aborted || this.currentSession() !== sessionId) {
      jpeg?.fill(0);
      return null;
    }
    return { jpeg, capturedAt: new Date(this.now()).toISOString(), device: "USB camera", purpose, consentId: pending.consentId };
  }

  endSession(sessionId: string): void {
    if (this.pending?.sessionId === sessionId) this.pending = null;
  }
}

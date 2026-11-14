import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { CameraCapture, orientCameraJpeg } from "../src/camera/capture.js";

const frame = () => Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

describe("CameraCapture", () => {
  it("rotates the camera pixels 180 degrees before processing", async () => {
    const width = 40;
    const pixels = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      pixels[at] = x < 20 && y < 20 ? 255 : 0;
      pixels[at + 1] = x >= 20 && y >= 20 ? 255 : 0;
    }
    const input = await sharp(pixels, { raw: { width, height: width, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    const output = await orientCameraJpeg(input);
    const raw = await sharp(output).raw().toBuffer();
    const topLeft = raw.subarray((5 * width + 5) * 3, (5 * width + 5) * 3 + 3);
    const bottomRight = raw.subarray((35 * width + 35) * 3, (35 * width + 35) * 3 + 3);
    expect(topLeft[1]).toBeGreaterThan(200);
    expect(bottomRight[0]).toBeGreaterThan(200);
  });
  it("requires an explicit reply to a pending per-session question and consumes consent once", async () => {
    let session: string | null = "s1";
    let captures = 0;
    const camera = new CameraCapture(() => session, async () => { captures++; return frame(); });
    const signal = new AbortController().signal;
    expect(await camera.captureOnce("s1", "inspect_scene", signal)).toBeNull();
    expect(camera.requestConsent("s1", "inspect_scene")).toContain("Yes, use the camera");
    expect(camera.acceptConsent("s1", "inspect_scene", "yes")).toBe(false);
    expect(camera.acceptConsent("s1", "inspect_scene", "Yes, use the camera.")).toBe(true);
    const captured = await camera.captureOnce("s1", "inspect_scene", signal);
    expect(captured).toMatchObject({ purpose: "inspect_scene", device: "USB camera" });
    expect(captured?.jpeg).toEqual(frame());
    expect(await camera.captureOnce("s1", "inspect_scene", signal)).toBeNull();
    expect(captures).toBe(1);
    session = null;
  });

  it("rejects expired, denied and previous-session consent", async () => {
    let session: string | null = "s1";
    let now = 1_000;
    const camera = new CameraCapture(() => session, async () => frame(), () => now);
    const signal = new AbortController().signal;
    camera.requestConsent("s1", "inspect_scene");
    now += 60_001;
    expect(camera.acceptConsent("s1", "inspect_scene", "yes use the camera")).toBe(false);
    camera.requestConsent("s1", "inspect_scene");
    expect(camera.acceptConsent("s1", "inspect_scene", "no thanks")).toBe(false);
    expect(await camera.captureOnce("s1", "inspect_scene", signal)).toBeNull();
    camera.requestConsent("s1", "inspect_scene");
    camera.acceptConsent("s1", "inspect_scene", "yes use the camera");
    session = "s2";
    expect(await camera.captureOnce("s1", "inspect_scene", signal)).toBeNull();
    expect(camera.requestConsent("s1", "inspect_scene")).toBeNull();
    camera.endSession("s1");
  });

  it("does not return a frame after cancellation or a failed capture", async () => {
    const controller = new AbortController();
    const camera = new CameraCapture(() => "s1", async () => { controller.abort(); return frame(); });
    camera.requestConsent("s1", "inspect_scene");
    camera.acceptConsent("s1", "inspect_scene", "yes use the camera");
    expect(await camera.captureOnce("s1", "inspect_scene", controller.signal)).toBeNull();
    expect(await camera.captureOnce("s1", "inspect_scene", new AbortController().signal)).toBeNull();
  });

  it("keeps local preview permission separate from one cloud upload", async () => {
    const camera = new CameraCapture(() => "s1", async () => frame());
    const signal = new AbortController().signal;
    const prompt = camera.requestConsent("s1", "cloud_interpretation");
    expect(prompt).toContain("send it to Clara's cloud");
    expect(camera.acceptConsent("s1", "cloud_interpretation", "Yes, use the camera")).toBe(false);
    expect(camera.acceptConsent("s1", "cloud_interpretation", "Yes, send the photo.")).toBe(true);
    expect(await camera.captureOnce("s1", "inspect_scene", signal)).toBeNull();
    const captured = await camera.captureOnce("s1", "cloud_interpretation", signal);
    expect(captured).toMatchObject({ purpose: "cloud_interpretation", consentId: expect.any(String) });
    expect(await camera.captureOnce("s1", "cloud_interpretation", signal)).toBeNull();
  });

  it("treats an explicit camera request as a single-use cloud grant", async () => {
    const camera = new CameraCapture(() => "s1", async () => frame());
    const signal = new AbortController().signal;
    expect(camera.grantFromRequest("s1", "The camera is plugged in")).toBe(false);
    expect(camera.grantFromRequest("s1", "Do not take a photo")).toBe(false);
    expect(camera.grantFromRequest("other", "Take a photo")).toBe(false);
    expect(camera.grantFromRequest("s1", "Please take a photo")).toBe(true);
    expect(await camera.captureOnce("s1", "cloud_interpretation", signal)).toMatchObject({ purpose: "cloud_interpretation" });
    expect(await camera.captureOnce("s1", "cloud_interpretation", signal)).toBeNull();
  });
});

import { z } from "zod";

/** One consented frame, never a continuous feed. The JPEG is transient and is not an event-log field. */
export const CAMERA_INSPECT_VERSION = "camera-inspect/0.2" as const;
export const CAMERA_MAX_BASE64_CHARS = 1_100_000;

export const CameraInspectRequestSchema = z.strictObject({
  schema_version: z.literal(CAMERA_INSPECT_VERSION),
  session_id: z.uuid(),
  task_id: z.uuid(),
  consent_id: z.uuid(),
  consent_scope: z.literal("capture_and_send_once"),
  captured_at: z.iso.datetime({ offset: true }),
  image_base64: z.string().min(100).max(CAMERA_MAX_BASE64_CHARS).regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type CameraInspectRequest = z.infer<typeof CameraInspectRequestSchema>;

export const CameraInspectResponseSchema = z.strictObject({
  schema_version: z.literal(CAMERA_INSPECT_VERSION),
  task_id: z.uuid(),
  status: z.enum(["observed", "unavailable"]),
  /** Detailed visual-only observation from one multimodal model call; never a diagnosis or care instruction. */
  observation: z.string().max(1400).nullable(),
  limitation: z.string().max(160),
  captured_at: z.iso.datetime({ offset: true }),
  observed_at: z.iso.datetime({ offset: true }),
});
export type CameraInspectResponse = z.infer<typeof CameraInspectResponseSchema>;

// Adapted from Sophi (github.com/mzhao1599/sophi), packages/walker-screen/src/view.ts: one plain view model
// the box service sends whole to the page, and a closed list of presses the page may send back. Walker-specific
// states (navigation, lift, captions of private messages) are dropped.
import { z } from "zod";
import { Id } from "@clara/contracts";

export type ScreenPhase = "idle" | "guiding" | "countdown" | "sos";
export const SCREEN_VIEW_VERSION = "screen-view/1.1" as const;
export type ScreenVoiceState = "off" | "starting" | "ready" | "listening" | "processing" | "speaking" | "unavailable";

export interface ScreenStep {
  step_id: string;
  label: string;
  text: string;
  /** URL on the screen server (`/content/...`), or null. */
  image_url: string | null;
  /** The kit item for this step: lit only when the manifest has it on hand. */
  item: { sku: string; name: string | null; slot: string | null; lit: boolean; missing: boolean } | null;
  can_back: boolean;
  can_next: boolean;
  /** Other ways forward (branches), shown as buttons when there is more than one. */
  options: { step_id: string; label: string }[];
  is_end: boolean;
}

/** The current visual, independent of whether the scenario engine has a step. */
export interface ScreenPresentation {
  kind: "answer" | "question" | "guidance" | "item" | "diagram" | "reading" | "handoff" | "status";
  title: string;
  body: string;
  /** Only local, allowlisted `/content/...` assets may be provided by a producer. */
  image_url: string | null;
  item: ScreenStep["item"];
  source_label: string | null;
}

export interface ScreenView {
  schema_version: typeof SCREEN_VIEW_VERSION;
  revision: number;
  phase: ScreenPhase;
  /** Physical lid state; an SOS session may exist while the lid and microphone are closed. */
  lid_open: boolean;
  box_name: string;
  /** The box's link to the server. Local simulated SOS works either way. */
  online: boolean;
  /** Simulator, or parts missing: shown as a tag so nobody mistakes it for the real thing. */
  simulated: boolean;
  scenario_title: string | null;
  step: ScreenStep | null;
  /** Additive in screen-view/1.0; `step` remains for older consumers. */
  presentation: ScreenPresentation | null;
  countdown: { seconds_left: number; total: number } | null;
  /** Mock 911 only: never a real call. */
  sos: { need: "bleeding" | "breathing" | "general"; opened_at: number; overlay: boolean; coaching: string[] } | null;
  /** From comingLine() only: null until someone really accepted. */
  coming: string | null;
  nearby: { incident_id: string; from_box_name: string; directions: string; bringing: boolean }[];
  timers: { timer: "tourniquet" | "pressure"; started_at: number }[];
  multiple_injured: boolean;
  /** The last line the box said (or the question it asked). */
  caption: string | null;
  notice: string | null;
  messages: { from: string; text: string; at: number }[];
  pending_usage: { sku: string; name: string; qty: number }[] | null;
  voice_available: boolean;
  /** Actual voice-loop activity; the lid and hands-free capability gate the displayed state. */
  voice_state: ScreenVoiceState;
  /** The scene report link for the QR code; null until the server gives one. */
  report_url: string | null;
}

/** What the page may send (POST /screen/press). Anything else is refused with 400. */
export const ScreenPressSchema = z.union([
  z.strictObject({
    action: z.enum([
      "start",
      "next",
      "back",
      "repeat",
      "talk",
      "talk_end",
      "sos",
      "cancel_sos",
      "show_911",
      "hide_911",
      "multiple_injured",
      "confirm_usage",
      "dismiss_usage",
      "dismiss_notice",
    ]),
  }),
  z.strictObject({ action: z.literal("goto"), step_id: Id }),
  z.strictObject({ action: z.enum(["bringing_kit", "dismiss_nearby"]), incident_id: Id }),
]);
export type ScreenPress = z.infer<typeof ScreenPressSchema>;

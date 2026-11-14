import type { GpsFix } from "../location/gps.js";

/**
 * The box's own fixed lines. None of them promise help, diagnose, or give first-aid advice: first-aid words come
 * only from the checked scenario, and who is coming only from comingLine().
 */
export const LINES = {
  countdown: (seconds: number) => `Opening the simulated emergency call in ${seconds} seconds. Tap Cancel to stop.`,
  cancelled: "Simulated call cancelled.",
  sosOpened: "This is a simulated 911 call. No real call is being made. The screen shows what to tell a dispatcher.",
  noVoice: "Voice is not available right now. The simulated SOS button remains on screen.",
  itemMissing: (name: string | null) => `${name ?? "That item"} is not in this box.`,
  endOfSteps: "That was the last step. The simulated SOS button stays on screen.",
  helperWithdrew: "The person who accepted can no longer come. The SOS stays open.",
  responderMessage: (from: string, text: string) => `Message from ${from}: ${text}`,
  usageConfirmed: "Supply count updated.",
  nearbyAsked: "I've asked the other Clara boxes nearby to bring their kits. The screen shows it if someone accepts.",
  nearbyAskedOffline: "Offline: the request to nearby Clara boxes is sent when the link returns.",
  nearbyEmergency: (from: string, directions: string) => `Emergency at ${from}. Please bring this kit.${directions ? ` ${directions}` : ""}`,
  noPulse: "I can't detect a pulse. Is the person responding? Are they breathing normally?",
} as const;

/** What the mock-911 screen coaches the bystander to say. Phrasing for the call only, never medical advice. */
export function coachingLines(o: { directions: string | null; multipleInjured: boolean; location?: GpsFix | null; configuredAddress?: string | null }): string[] {
  const where = o.location
    ? `GPS coordinates: ${o.location.latitude.toFixed(5)}, ${o.location.longitude.toFixed(5)} (fix ${new Date(o.location.observedAt).toISOString()}).`
    : o.configuredAddress
      ? `GPS unavailable. Configured box address: ${o.configuredAddress}.`
      : "GPS unavailable. Tell the dispatcher your location.";
  return [
    `Say where you are. ${where}${o.directions ? ` Additional directions: ${o.directions}.` : ""}`,
    o.multipleInjured ? "Say that more than one person is hurt, and how many." : "Say what happened and how many people are hurt.",
    "Say what has been done so far.",
    "Answer the dispatcher's questions and stay on the line.",
  ];
}

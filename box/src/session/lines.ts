/**
 * The box's own fixed lines. None of them promise help, diagnose, or give first-aid advice: first-aid words come
 * only from the checked scenario, and who is coming only from comingLine().
 */
export const LINES = {
  countdown: (seconds: number) => `Opening the simulated emergency call in ${seconds} seconds. Tap Cancel to stop.`,
  cancelled: "Simulated call cancelled.",
  sosOpened: "This is a simulated 911 call. No real call is being made. The screen shows what to tell a dispatcher.",
  noVoice: "Voice is not available right now. Use the buttons on the screen.",
  itemMissing: (name: string | null) => `${name ?? "That item"} is not in this box. Use the screen to continue.`,
  endOfSteps: "That was the last step. The simulated SOS button stays on screen.",
  helperWithdrew: "The person who accepted can no longer come. The SOS stays open.",
  responderMessage: (from: string, text: string) => `Message from ${from}: ${text}`,
  nearbyEmergency: (boxName: string) => `Emergency at ${boxName}. See the screen.`,
  usageConfirmed: "Supply count updated.",
} as const;

/** What the mock-911 screen coaches the bystander to say. Phrasing for the call only, never medical advice. */
export function coachingLines(o: { boxName: string; directions: string | null; multipleInjured: boolean }): string[] {
  return [
    `Say where you are: ${o.boxName}${o.directions ? `, ${o.directions}` : ""}.`,
    o.multipleInjured ? "Say that more than one person is hurt, and how many." : "Say what happened and how many people are hurt.",
    "Say what has been done so far.",
    "Answer the dispatcher's questions and stay on the line.",
  ];
}

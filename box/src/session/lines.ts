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

/** Spanish versions of LINES (draft: to be checked by a fluent speaker). */
export const LINES_ES: { [K in keyof typeof LINES]: (typeof LINES)[K] extends (...a: infer A) => string ? (...a: A) => string : string } = {
  countdown: (seconds: number) => `Abriendo la llamada de emergencia simulada en ${seconds} segundos. Toca Cancelar para detenerla.`,
  cancelled: "Llamada simulada cancelada.",
  sosOpened: "Esta es una llamada al 911 simulada. No se está haciendo ninguna llamada real. La pantalla muestra qué decirle al operador.",
  noVoice: "La voz no está disponible ahora. El botón de SOS simulado sigue en pantalla.",
  itemMissing: (name: string | null) => `${name ?? "Ese material"} no está en esta caja.`,
  endOfSteps: "Ese era el último paso. El botón de SOS simulado sigue en pantalla.",
  helperWithdrew: "La persona que aceptó ya no puede venir. El SOS sigue abierto.",
  responderMessage: (from: string, text: string) => `Mensaje de ${from}: ${text}`,
  usageConfirmed: "Recuento de material actualizado.",
  nearbyAsked: "He pedido a las otras cajas Clara cercanas que traigan sus kits. La pantalla lo mostrará si alguien acepta.",
  nearbyAskedOffline: "Sin conexión: la petición a las cajas cercanas se enviará cuando vuelva la conexión.",
  nearbyEmergency: (from: string, directions: string) => `Emergencia en ${from}. Por favor, lleva este kit.${directions ? ` ${directions}` : ""}`,
  noPulse: "No detecto pulso. ¿La persona responde? ¿Respira con normalidad?",
};

/** The box's fixed lines in a language: Spanish when it's es, otherwise English. */
export function linesFor(language: string): typeof LINES_ES {
  return language.startsWith("es") ? LINES_ES : LINES;
}

/** The greeting when the lid opens. */
export const GREETINGS: Record<string, string> = {
  en: "I'm Clara, I'm here to help. Let me know what happened and I can guide you through treatment, diagnosis, or call for help.",
  es: "Soy Clara y estoy aquí para ayudar. Cuéntame qué pasó y te guiaré paso a paso o te ayudaré a pedir ayuda.",
};

/** What the mock-911 screen coaches the bystander to say. Phrasing for the call only, never medical advice. */
export function coachingLines(o: { directions: string | null; multipleInjured: boolean; location?: GpsFix | null; configuredAddress?: string | null; language?: string }): string[] {
  if (o.language?.startsWith("es")) {
    const donde = o.location
      ? `Coordenadas GPS: ${o.location.latitude.toFixed(5)}, ${o.location.longitude.toFixed(5)} (lectura ${new Date(o.location.observedAt).toISOString()}).`
      : o.configuredAddress
        ? `GPS no disponible. Dirección configurada de la caja: ${o.configuredAddress}.`
        : "GPS no disponible. Dile al operador dónde estás.";
    return [
      `Di dónde estás. ${donde}${o.directions ? ` Indicaciones: ${o.directions}.` : ""}`,
      o.multipleInjured ? "Di que hay más de una persona herida y cuántas." : "Di qué pasó y cuántas personas están heridas.",
      "Di lo que se ha hecho hasta ahora.",
      "Responde a las preguntas del operador y no cuelgues.",
    ];
  }
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

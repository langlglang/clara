/**
 * The honesty guard, checked in code on every reply Clara would speak in the model's own words (inspired by
 * Standard Response's honesty guard). It blocks promises of help or arrival times, false comfort, diagnoses,
 * medical advice the model wrote itself (guidance comes only from recorded steps), and digits (a number in a
 * reply is either a measurement, a time or a phone number, none of which the model may invent). A blocked
 * reply is retried once with the rule as a note; a second block becomes a fixed line. A guard, not a guarantee:
 * it is conservative on purpose, since the fallback is a safe fixed line.
 */

export interface HonestyRule {
  id: "promise" | "false_comfort" | "diagnosis" | "advice" | "digits";
  pattern: RegExp;
  /** Sent back to the model as the retry note. */
  note: string;
}

const PEOPLE = String.raw`(help|an? ambulance|ambulances|paramedics?|(the )?doctors?|(a |the )?nurses?|rescue|rescuers|someone|somebody|responders?|emergency services|911|they|the police|firefighters)`;
const CONDITIONS = String.raw`(broken|fractured?|fractures|sprain(ed)?|dislocat\w*|concussion|stroke|heart attack|cardiac arrest|seizure|epilep\w*|shock|hypotherm\w*|heat ?stroke|anaphyla\w*|allergic reaction|asthma attack|diabet\w*|hypoglyc\w*|internal bleeding|poison(ed|ing)|overdose|infect(ed|ion)|burn of|(first|second|third)[- ]degree)`;

export const HONESTY_RULES: HonestyRule[] = [
  {
    id: "promise",
    pattern: new RegExp(
      String.raw`\b${PEOPLE}(\s+(is|are|will be)|'s|'re|'ll be)\s+(coming|on (its|their|the|his|her) way|here soon|nearly here|almost here|arriving|close|en route|dispatched|notified)\b` +
        String.raw`|\b(on (its|their|the|his|her) way|en route|any (moment|minute) now|arrive (soon|shortly|in)|will arrive|be here (soon|shortly|in))\b` +
        String.raw`|\bI('ve| have|'m| am)?\s*(called|calling|contacted|contacting|alerted|alerting|notified|dispatched|sent for)\b` +
        String.raw`|\bhelp is (coming|near|close)\b|\b(in|within) (a few|a couple of|\w+) (minutes?|seconds?)\b`,
      "i",
    ),
    note: "Never say help or anyone is coming or on the way, never give an arrival time, and never say you called or contacted anyone. The box announces that itself.",
  },
  {
    id: "false_comfort",
    pattern:
      /\b(you|he|she|they|it|everything|everyone|this|that)('ll| will| is going to| are going to| 're going to| 's going to)\s+(be\s+)?(fine|okay|ok|alright|all right|good|safe)\b|\b(it|that|this)('s| is)\s+(okay|ok|fine|alright|all right|not serious|nothing serious)\b|\b(don't|do not) worry\b|\bnothing to worry about\b|\bno need to (worry|panic)\b|\b(not|nothing) (that |too )?serious\b|\bno big deal\b/i,
    note: "Never reassure about the outcome or say it's okay. Acknowledge the person without promising an outcome.",
  },
  {
    id: "diagnosis",
    pattern: new RegExp(
      String.raw`\bdiagnos\w*\b` +
        String.raw`|\b(it|that|this)('s| is| was| might be| could be| may be| must be)\s+(definitely |probably |likely |just |only )?(an? )?${CONDITIONS}` +
        String.raw`|\b(sounds|looks|seems) like\s+(an? )?${CONDITIONS}` +
        String.raw`|\b(probably|likely|possibly|maybe)\s+(an? )?${CONDITIONS}` +
        String.raw`|\b(you|he|she|they)('ve| have| has|'s| is| are|'re)\s+(got\s+)?(an? )?${CONDITIONS}` +
        String.raw`|\b(you|he|she|they) (have|has|had) an? \w+ (fracture|injury|wound)\b`,
      "i",
    ),
    note: "Never diagnose or name a condition. Describe only what the person reported.",
  },
  {
    id: "advice",
    pattern:
      /\b(press(ing)? (hard|firmly|down|on|it|the wound)|apply|applying|elevate|raise (the|his|her|their)|wrap|bandage|compress|tie|tighten|pack the|clean the|rinse|pour|splint|ice (it|the)|cool (it|the)|put (pressure|ice|a)|tilt|roll (him|her|them)|lay (him|her|them)|move (him|her|them)|keep (him|her|them) (still|warm|lying)|give (him|her|them)|start cpr|cpr|chest compressions?|rescue breaths?|recovery position|heimlich|aspirin|ibuprofen|paracetamol|acetaminophen|epinephrine|epipen)\b/i,
    note: "Never give first-aid or medical instructions in your own words. To guide them, choose select_step and leave reply empty.",
  },
  {
    id: "digits",
    pattern: /\d/,
    note: "Never use digits or numbers in the reply: no times, measurements or phone numbers.",
  },
];

/** The first rule the reply breaks, or null when it passes. */
export function checkHonesty(reply: string): HonestyRule | null {
  for (const rule of HONESTY_RULES) if (rule.pattern.test(reply)) return rule;
  return null;
}

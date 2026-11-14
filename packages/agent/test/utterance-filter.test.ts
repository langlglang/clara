import { describe, expect, it } from "vitest";
import { isObviousNonRequestTranscript } from "../src/utterance-filter.js";

describe("obvious non-request audio transcripts", () => {
  it.each(["", "  ...  ", "!!!", "um", "Uh, um.", "hmm hmm", "(inaudible)", "[no speech]", "[background noise]", "[Music]"])(
    "drops %j",
    (words) => expect(isObviousNonRequestTranscript(words)).toBe(true),
  );

  it.each(["help", "yes", "no", "SOS", "scissors", "gauze", "bleeding", "Okay", "uh, help", "hmm, yes", "what is that noise?", "ayuda"])(
    "keeps %j",
    (words) => expect(isObviousNonRequestTranscript(words)).toBe(false),
  );
});

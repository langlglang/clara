import { describe, expect, it } from "vitest";
import { checkHonesty } from "../src/honesty.js";

describe("checkHonesty", () => {
  it.each([
    ["An ambulance is coming.", "promise"],
    ["Help is on its way.", "promise"],
    ["Someone is on the way.", "promise"],
    ["Paramedics will be here soon.", "promise"],
    ["I've called for help.", "promise"],
    ["I contacted emergency services.", "promise"],
    ["They're coming.", "promise"],
    ["You'll be fine.", "false_comfort"],
    ["She will be okay.", "false_comfort"],
    ["Everything will be alright.", "false_comfort"],
    ["It's okay.", "false_comfort"],
    ["Don't worry, keep going.", "false_comfort"],
    ["It's broken.", "diagnosis"],
    ["That is probably a fracture.", "diagnosis"],
    ["It sounds like a concussion.", "diagnosis"],
    ["He's having a stroke? It might be a stroke.", "diagnosis"],
    ["My diagnosis is a deep cut.", "diagnosis"],
    ["Press hard on the wound.", "advice"],
    ["Apply the bandage tightly.", "advice"],
    ["Start CPR now.", "advice"],
    ["Give her an aspirin.", "advice"],
    ["Put him in the recovery position.", "advice"],
    ["Wait about ten seconds, then 5 more.", "digits"],
    ["Call 911.", "digits"],
  ])("blocks %s", (text, id) => expect(checkHonesty(text)?.id).toBe(id));

  it.each([
    "Tap the SOS button on the screen if you need emergency help.",
    "Tell me where the bleeding is.",
    "I didn't catch that. Tell me again, or tap the step on the screen.",
    "The gauze is in the slot that is lit.",
    "I hear you. Follow the step on the screen.",
    "You're doing well. Tap the step on the screen when you're ready.",
    "Okay. Tell me what happened.",
  ])("allows %s", (text) => expect(checkHonesty(text)).toBeNull());
});

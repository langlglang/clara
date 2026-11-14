# Fictional-scenario content and demo boundaries

**Clara is a HackPrinceton proof of concept and will never be used on a patient.** There is no treatment-validation, clinical-review, certification, or deployment milestone. The agent demonstrates conversation, tool use, kit navigation and synchronized instructions using fictional first-aid scenarios. The ordinary kiosk conversation does not carry a demo banner. The SOS button says “911 Guide”; the countdown and call overlay explicitly state that 911 is simulated and no real call is made. The scripted lid greeting is the owner's requested demo line and does not indicate that diagnosis or a real call is implemented. This repository and project documentation identify the build as a prototype. Do not describe it as a certified medical device or imply a real emergency call occurred.

## Source registry, checked 2026-11-02

These primary sources inform the *fictional demonstration script*. They are not a Clara treatment protocol or a claim of clinical validation.

| Source | Demo use |
| --- | --- |
| [AHA 2025 Adult Basic Life Support Guidelines](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support) | Emergency-first framing and AED/CPR scenario reference |
| [AHA/Red Cross 2024 First Aid Guidelines](https://cpr.heart.org/en/resuscitation-science/2024-first-aid-guidelines) | General first-aid reference |
| [Red Cross First Aid Steps](https://www.redcross.org/take-a-class/first-aid/performing-first-aid/first-aid-steps) | Check/call/care sequence for demo storyboarding |
| [Red Cross life-threatening external bleeding](https://www.redcross.org/take-a-class/resources/learn-first-aid/bleeding-life-threatening-external) | Source for the candidate fictional bleeding scene |
| [ACS Stop the Bleed v3.0 instructor guide, 2025](https://www.stopthebleed.org/media/pkpnanvp/acs-stop-the-bleed-version-30-instructor-guide.pdf) | Visual and kit-flow reference; check reuse rights before copying assets |
| [911.gov calling 911 FAQ](https://www.911.gov/calling-911/frequently-asked-questions/) | Wording and location prompts in a simulated SOS flow |

## Content workflow for the demo

1. Pick one fictional adult scenario. Record source URL, retrieval date, included facts, and the exact demo step text and illustrations in a versioned bundle.
2. Have teammates compare every step against the linked source and check that screen and speech use the same wording and step ID. This is a product-content check, **not clinical validation**.
3. Bind the agent to those steps and kit slots. The model may ask questions, use the camera, find supplies and request a sensor result, but cannot fabricate a measurement or claim to have diagnosed the fictional person.
4. Keep the simulated emergency action visible. The agent must not wait for a sensor or camera result before showing it in an emergency scene.
5. Rehearse uncertainty, missing supply, offline, sensor disconnect, interruption and no-result paths. Never let a failed tool return an invented value.

The AHA guideline prioritizes emergency activation for a lone lay rescuer with presumed adult cardiac arrest, and the Red Cross bleeding page identifies situations needing immediate emergency care. That is why the demo shows an early mock SOS rather than making a device reading a prerequisite. This is an interface design decision for a fictional scene.

## Superficial-cut visual bundle — `minor-cut-demo-v1` (draft)

The original [`minor-cut-sequence-v1.svg`](../content/visuals/minor-cut-sequence-v1.svg) is linked by step `rinse_cover` in [`minor-cut.json`](../content/scenarios/minor-cut.json). The screen text and spoken text come from that one step. **Source review on 2026-11-13:** [AHA/Red Cross 2024 First Aid Guidelines, §9.3](https://cpr.heart.org/en/resuscitation-science/2024-first-aid-guidelines) supports irrigating a superficial wound until visible debris is gone, using running tap water or sterile saline, and covering the clean wound. The [American Red Cross First Aid/CPR/AED Participant’s Manual, p. 97 (©2011, 2016)](https://www.redcross.org/content/dam/redcross/training-services/no-index/First%20Aid-CPR-AED-Participant%27s-Manual.pdf) names an adhesive bandage as a covering option. The 2024 guideline controls if wording differs. Art is original; no source illustration is copied.

**Boundary:** only a user-described superficial cut or scrape. The box manifest contains neither running water nor sterile saline; the wording conditions rinsing on access to one outside the box and never presents either as stocked. This bundle does not address heavy or uncontrolled bleeding, deep/extensive wounds, punctures, bites, or wounds with infection signs. The AHA/Red Cross guideline calls for medical evaluation of bite/saliva-contaminated superficial wounds and care when redness, swelling, foul drainage, increased pain, or fever develops. The scenario is **draft** until a teammate checks the exact text, asset labels, stock SKU, and exclusion behavior against these sources. It is an optional configured scenario, not the Pi’s default, and there is no dynamic scenario routing yet. Its inclusion does not establish clinical validity.

The owner’s “alcohol pad then bandaid” example is **not** the sequence depicted. The manifest confirms antiseptic towelettes, not alcohol pads, and the 2024 guideline favors tap water or saline over antiseptic agents for this superficial-wound cleaning step. Clara may show the towelette as an item illustration but does not instruct its use in this bundle.

The nearby CPR-trained volunteer idea is a **later product concept**, modeled only as a fictional preview at HackPrinceton. A real invitation must never delay emergency contact, and the agent must not infer a CPR need from the camera or sensor. [PulsePoint's existing program](https://www.pulsepoint.org/pulsepoint-respond) is an example of opt-in, dispatch-coordinated alerts, not an integration or endorsement of Clara. A handoff to someone arriving must label reports, observations, times and unknowns; it cannot invent a diagnosis, an action taken or a responder outcome.

## Live sensor presentation

A consenting volunteer may use an actual cuff or optical sensor. The UI shows the returned value, device, units and time. No separate experimental badge is required. The engineering notes record the model, connection, quality flags and known limitations. A value can demonstrate that the tool read hardware; it does not control the fictional care flow.

If the project were ever repurposed for patient use, that would be a different scope requiring new clinical, regulatory and emergency-service work. It is **not** part of Clara's plan.

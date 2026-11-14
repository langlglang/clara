# Clara feature inventory — proposal

**Status as of 2026-11-03:** documentation only. Nothing below is marked implemented or verified. “Demo target” means a planned HackPrinceton interaction with fictional scenarios and consenting volunteers; “later concept” means work outside this demo. Clara will never be used on a patient.

| Feature | Phase | What is proposed |
| --- | --- | --- |
| Lid-open start | Demo target | ESP32 reads the limit switch over GPIO and tells the already-running Pi over USB; the local screen appears without waiting for cloud startup. |
| Battery-powered box | Demo target | The available 12 V battery feeds a checked, fused power path; actual closed-lid runtime and Pi power compatibility still need measurement. |
| Touchscreen | Demo target | Large controls, captions, replay, step navigation, visible offline state and a persistent Mock SOS entry point. |
| Voice conversation | Demo target | Hands-free listening while a session is active, one server turn per utterance (speech-to-text → Claude choosing one allowed action → speech), recorded step audio, Talk/Stop interrupt, fixed lines on any failure. See [voice](voice.md); a scaffold exists, not yet run on hardware or real APIs. |
| Tool-using cloud agent | Demo target | A warm runtime uses protocol, inventory, camera, sensor and visual tools with typed results, deadlines and cancellation. |
| Session context and evidence | Demo target | The agent tracks user reports, observations, consent, current step and tool provenance without treating a summary as a measurement. |
| Versioned scenario guidance | Demo target | Fictional, source-linked steps are constrained to a reviewed bundle; text, speech and illustrations share a step ID. |
| Movable camera | Demo target | A volunteer aims the USB camera and explicitly consents to a single-frame capture; uncertainty is shown. |
| Wired optical sensor | Demo target | A MAX30102 feeds fresh raw samples to ESP32 by I²C; a pulse value appears only after the signal-processing path is checked. |
| Other monitoring devices | Later concept | Additional connected devices would be selected by interface, data provenance and fitness for their intended use, rather than electrical compatibility alone. |
| Versioned kit map | Demo target | A verified per-box manifest connects supply SKU, physical slot and matching screen image. |
| Running supply ledger | Demo target | No weight or slot sensors. At session end the box asks what was used; the LLM maps the answer to manifest SKUs, the user confirms with a tap, and plain code updates the count. Unconfirmed use marks slots unverified; low stock raises a restock alert at the hub. See [kit inventory](subsystems/kit-inventory.md). |
| Physical slot highlighting | Demo target | An ESP32-controlled LED beside a verified compartment lights when that item is requested; the LED part is still a candidate. |
| Offline guide | Demo target | Cached fictional steps, kit map, screen controls and Mock SOS stay available without the cloud. |
| Box finder | Demo target | Companion app shows fictional box sites, access notes and availability age; optional GPS is secondary to a verified site address. |
| Optional box GPS | Demo target | A GT-U7 can provide a fresh, accuracy-marked observation; indoor failure leaves the verified site record as the location source. |
| Mock SOS | Demo target | Box and app show a local simulation with fictional location; no emergency call or message is sent. |
| Responder alert preview | Demo target | An in-app simulation shows which *fictional, opted-in CPR-trained volunteers* might receive an alert. It sends no push notification and never says anyone is coming. |
| Arrival handoff card | Demo target | On request, the box shows a short, source-labeled summary of the fictional situation, steps already shown, open questions and mock SOS state for another person who arrives. It works from local session facts if the cloud is down. |
| Box status map | Demo target | Each box sends a heartbeat to a box registry; a network map shows `ready`, `in_use`, `low_supplies` or `offline` with last-seen time, and pulses boxes in use. See [box network](subsystems/box-network.md). |
| Nearby box alert | Demo target | When one box's Mock SOS opens, other demo boxes at the same site chime, flash and show "Emergency at Room 101, bring this kit" with pre-written directions. A **Bringing this kit** tap is shown back as unconfirmed. Box B can be a mock box (laptop or tablet). |
| Nearest other kit | Demo target | When an item is missing or there are more injured people, the box shows the nearest other box with fresh status and verified directions. |
| Open chime | Demo target | A short chime and light flash on lid open, silenced by any touch, scenario start or Mock SOS. No lock, code or delay. See [anti-theft](subsystems/anti-theft.md). |
| Open snapshot | Demo target, needs team privacy decision | One frame per lid open, stored locally and encrypted for the maintainer only, deleted after a short retention unless flagged. Never used for guidance or sent to the agent. |
| Non-emergency open flag | Demo target | An open with no scenario, agent session or Mock SOS that runs long, or where a high-value item is reported gone, is flagged in the maintainer view with time and snapshot. |
| Mount-removal alert | Demo target | A bracket limit switch reports removal. During an emergency the box asks to be returned and starts a return timer; with no emergency the maintainer is alerted right away. |
| Accelerometer, GPS and cellular theft tracking | Later concept | Detect carrying or prying, report location after removal, alert without Wi-Fi. |
| Slow-theft and tamper detection | Later concept | Inventory history patterns, pry or screen-removal sensing, power-cut alerts. |
| Real emergency calling | Later concept | Would require a separate patient-use project, emergency-service integration, reliability and legal review. It is not part of Clara's demo. |
| Nearby trained volunteer alerts | Later concept | After an eligible SOS, a separate service could notify opted-in, available, appropriately trained nearby volunteers in parallel with emergency contact. Training, privacy, dispatch coordination and misuse controls remain unresolved. |
| Secure responder handoff | Later concept | With authorization, an accepted SOS recipient could view a minimal, expiring context card; unaccepted or unrelated users would not see it. |
| Privacy controls | Demo target for session controls; later review for deployment | Per-session media consent, scoped access, transient data and deletion; real responder alerts would need additional location and identity protections. |
| Failure recovery | Demo target | The screen handles cloud loss, stale sensors, missing supplies, interrupted speech and wrong kit revisions without fabricated results. |

The [project plan](project-plan.md) defines demo acceptance; [architecture](architecture.md), [agent runtime](agent-runtime.md), [contracts](contracts.md), [emergency workflow](subsystems/emergency-workflow.md), [box network](subsystems/box-network.md), and [anti-theft](subsystems/anti-theft.md) describe how the parts connect. Do not promote a row to **demo implemented** or **demo verified** without testing the actual behavior.

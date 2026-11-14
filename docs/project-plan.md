# Clara HackPrinceton proof-of-concept plan

**Status:** parts of the demo are implemented; the general conversation and multiagent runtime are proposed. See the [current feature list](feature-list.md) for exact status and [conversation runtime](conversation-runtime.md) for the target. Clara will never be used on a patient. The demo uses fictional first-aid situations and consenting volunteers for the microphone, camera and live sensor. The concept is motivated by public AED locations and disaster response, but this project has no field placement, treatment validation, or public-use milestone.

## Milestones and acceptance

| Milestone | Deliverable | Acceptance evidence |
| --- | --- | --- |
| M0 — parts | Record the team's selected electronics, inspect delivered connectors, and finish the available 12 V battery power design | [Parts list](prototype-parts.md), confirmed connector map, fused power plan, budget and demo script |
| M1 — lid wake | ESP32 lid event over USB serial, Pi idle-screen reveal | 20 open/close trials; measured time to visible UI; serial reconnect works |
| M2 — local UI | Idle/listening state, general presentation surface, source-labeled item location, and persistent simulated SOS; no step-navigation buttons | Lid open produces no model request; an answer or item request renders without a required step; mock SOS works with lid closed and offline |
| M3 — core agent | Live ASR, a single continuous user-facing conversation, typed protocol/inventory/camera/sensor/presentation tools, and background task supervisor | Trace shows request-triggered work, tool provenance, visual/speech synchronization, interruption, concurrent SOS or responder task, and cloud-disconnect fallback |
| M4 — live sensor | `sensor.read` connects to the selected MAX30102 by 3.3 V ESP32 I²C and existing Pi USB serial; ESP32 computes bpm locally from a fresh sample window | New live optical samples appear with model, unit and timestamp; stale/disconnected device returns unavailable; no random fallback. Display bpm only after the algorithm passes finger/motion/reference checks. |
| M5 — show demo | Box, companion directory, simulated SOS, test-volunteer network, optional team-owned demo dispatcher phone, and proposed on-box handoff card | End-to-end fictional scenario, no emergency-service call, clear failure recovery; distinguish sent, accepted, and arrived. A configured Twilio demo call reports API placement separately from phone answer; later fact-worker answers are not in its one-time briefing. Handoff remains proposed. |
| M6 — box network | Box heartbeat and registry, network map, second (mock) box, nearby box alert on Mock SOS, nearest-kit card | Box A's Mock SOS opens Box B's alert card within a few seconds when connected; Box A works unchanged with the network unplugged and says nearby boxes were not notified; duplicate SOS sends one alert; stale box shows `offline` and is never suggested. See [box network](subsystems/box-network.md). |
| M7 — anti-theft | Open chime, open snapshot, non-emergency open flag, mount-removal switch and return timer, maintainer view | Chime stops within 250 ms of a touch or Mock SOS; snapshot failure never delays the open screen; a long open with no emergency produces one flag; removing the box during a session starts the return timer and returning it cancels the alert; expired snapshots are deleted. See [anti-theft](subsystems/anti-theft.md). |

The sensor tool must read hardware, not a fixture. The first scenario can work without the sensor; a separate demo segment can show the live measurement tool. The team selected the [MAX30102 Amazon breakout](https://www.amazon.com/dp/B07ZQNC8XP) for live optical input. It needs signal processing for a pulse number. See [sensor selection](sensor-selection.md).

The earlier offline-first/touch-navigation build is retained as a [historical software plan](software-plan.md); sponsor targets are in [sponsors](sponsors.md). The active interaction design is [conversation runtime](conversation-runtime.md).

## Open decisions

1. Available 12 V battery chemistry, capacity, charging/protection, fuse, master-switch rating, converter output and Pi USB-C power interface. The selected converter and bare-wire pigtail do not close this design.
2. Check whether the screen's supplied video lead fits Pi 5 micro-HDMI; verify hub input power and the movable camera mount.
3. Verify the selected MAX30102 board's 3.3 V I²C levels, pinout and live samples; choose/reference and check the ESP32 algorithm before showing numeric bpm.
4. Final physical kit slots, props and fictional scenario script.
5. Battery runtime with Pi running and all USB peripherals connected; GPS fix behavior indoors.
6. Choose the compartment LED part. The newer 3 V prewired candidate may use one ESP32 GPIO and series resistor per slot; confirm its actual current and brightness. The earlier 12 V candidate needs a driver. Verify every physical slot-to-output mapping.
7. For the mock responder preview, choose a small seeded set of fictional CPR/AED-trained volunteer profiles and one fictional public incident location. Do not enroll real users or send push notifications.
8. Define the fictional handoff card's permitted facts and a voice request such as “Show what happened for the person arriving”; decide whether the companion preview shows a fictional copy. Do not include live volunteer measurements without separate sharing consent.
9. Choose Box B's form for the network demo: a second physical box, or a mock box (laptop or tablet running the box screen, optionally with a second ESP32 and LEDs). Write and check the fictional site's box locations and directions between them.
10. Agree on the open snapshot. It is an exception to the "camera off unless the volunteer consents" rule: one frame per open, local and encrypted, maintainer-only, short retention, disclosed by sticker and screen. Drop it if the team is not comfortable.
11. Decide where maintainer alerts go in the demo: the maintainer view only, or also an SMS to a team test phone. Never to emergency services.
12. Select the buzzer and the mount-removal switch, and assign their ESP32 GPIOs alongside the lid switch, LEDs and MAX30102 I²C.

## Later product questions outside the demo

- Who is permitted to activate a real responder alert, and how does it coordinate with the local 911/EMS system without delaying emergency contact?
- How will CPR/AED training, credentials, expiration, opt-in, availability and public/private location eligibility be verified?
- What are the rules for approximate matching, location disclosure after acceptance, incident expiry, false alarms, abuse reporting and responder safety?
- Who may authorize sharing a context card, which facts can each recipient see, and how are access, expiry and revocation enforced?
- Which legal, privacy, liability, dispatch and regulatory approvals are required before a real network can notify anyone?

## Demo boundaries

The screen carries one overall **Clara Demo** identifier. It need not add a warning badge to every sensor value. Device name, units and timestamp remain visible so the reading is traceable. The agent may describe what the tool returned; it does not diagnose, use the value to select treatment, or claim emergency services were reached. The SOS interaction is mocked. Any later patient-use idea would be a separate project with new requirements.

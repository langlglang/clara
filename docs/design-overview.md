# Clara

**Status: planning, plus a proposed voice scaffold.** This directory contains no working firmware, app, touchscreen, emergency calling, or medical device. The voice scaffold in `server/` and `box/` passes its unit tests with stubs but has not run on hardware or real APIs ([how to run it](server/README.md)). Every behavior below is proposed unless explicitly marked as a demo acceptance target.

Clara (previously AutoAid) is a proposed AI assisted first aid box inspired by places where public AEDs are installed and disasters where bystanders may have to act while emergency services are strained. Opening the lid releases a switch and activates the box. A screen, microphone, speaker, movable camera, and connected accessories demonstrate supply finding and clear, accessible steps. A proposed LED at each kit compartment would light the location of the requested item. A companion app demonstrates box locations and a mock SOS; a later concept would notify opted-in nearby people with relevant first-aid training, such as CPR.

Clara is **only a HackPrinceton proof of concept**. It will never be used on a patient. The team's [selected parts list](docs/prototype-parts.md) uses a Pi 5 4 GB kit, a USB-connected ESP32-WROOM-32 board, an Elecrow touch display, USB microphone and soundbar, a movable InnoMaker USB camera, and a wired MAX30102 optical sensor. The team has a separate 12 V battery; its protection, charging, and Pi power connection are still being checked. No hardware is marked working yet.

## Start here

| Read | What it answers |
| --- | --- |
| [Software plan](docs/software-plan.md) | Proposed offline-first build for the low-resource story: components, AI design, demo script, team split, 36-hour build order |
| [Voice conversation](docs/voice.md) | How a bystander talks to Clara: hands-free clips, speech-to-text, Claude choosing one allowed action, recorded step audio; the scaffold in `server/` and `box/` |
| [Sponsor targets](docs/sponsors.md) | HackPrinceton tracks and which sponsor prizes Clara could target |
| [Project plan](docs/project-plan.md) | What the honest demo proves, later work, gates, and open choices |
| [Feature inventory](docs/features.md) | All planned demo features and later concepts, with status |
| [Architecture](docs/architecture.md) | Components, data flow, startup, offline behavior, failures |
| [Agent runtime](docs/agent-runtime.md) | Real tool loop, state, budgets, policies, examples |
| [Hardware and power](docs/hardware-power.md) | Compute choice, wiring proposal, power assumptions |
| [Prototype parts](docs/prototype-parts.md) | Supplied links, exact connections, missing parts and power checks |
| [Wired sensor choice](docs/sensor-selection.md) | ESP32/Pi I²C options and a real hardware sensor-tool path |
| [Contracts](docs/contracts.md) | Versioned messages, interfaces, errors, compatibility |
| [Demo safety](docs/medical-safety.md) | Source registry and fictional-scenario boundaries |
| [Privacy and security](docs/privacy-security.md) | Consent, access, retention, deletion, threat model |
| [Subsystem guides](docs/subsystems/README.md) | Plain-language handoffs for each team |

## Proposed user journey

1. The lid switch wakes the local controller. The running Pi immediately shows the **Clara Demo** screen, fictional site information and mock SOS control without waiting for network or AI.
2. A volunteer chooses a locally stored scenario or opts into the cloud agent. The agent listens, can request a single camera frame with consent, and uses tools to retrieve a versioned demo step or locate a physical item.
3. Each demo step has matching text, audio and illustration. When an item and its physical slot are verified, the corresponding compartment LED lights as an additional cue. The volunteer can interrupt, replay, enlarge or move to the next step.
4. The companion app shows a demo box directory and opens a mock SOS screen. It may preview fictional nearby trained volunteers; no emergency call, push notification or message is sent.
5. If another person arrives, the volunteer can show a source-labeled handoff card with the fictional situation, steps already shown, open questions and mock SOS state. A later real responder network could share a minimal version with an authorized SOS recipient.
6. When the Mock SOS opens, other demo boxes at the site chime and show "Emergency at Room 101, bring this kit" with directions, and a network map shows every box's status. If an item runs out, the box points to the nearest other kit. See [box network](docs/subsystems/box-network.md).
7. Anti-theft never blocks access: a short chime on open, one locally stored snapshot for the maintainer, a flag for opens with no emergency, and an alert if the box leaves its wall mount without being returned. See [anti-theft](docs/subsystems/anti-theft.md).

## Intended boundaries

- Scope: **US English, fictional adult scenarios, supervised HackPrinceton demonstration**. There is no patient use, treatment validation, or deployment work in this project.
- The agent uses source-linked demo steps and real tool calls. Its sensor tool reads hardware; SOS is simulated and never contacts emergency services.
- The overall UI identifies Clara as a demo. Sensor values show their device, units and time without a separate maker-grade warning badge. The agent does not diagnose or choose treatment from a reading.
- Public placement near AEDs remains the inspiration for the concept, not an implementation or pilot plan.

## Proposed repository map

```text
device/       ESP32 firmware and board support (future)
cloud/        agent runtime, APIs, protocol registry (future)
touchscreen/  on-box interface (future)
app/          companion mobile app (future)
contracts/    schemas and generated clients (future)
hardware/     CAD, BOM, electrical drawings (future)
docs/         current design documents
```

Before implementing, read [AGENTS.md](AGENTS.md) and the relevant contracts. Update status labels as code becomes demonstrably functional; do not infer completion from a mockup.

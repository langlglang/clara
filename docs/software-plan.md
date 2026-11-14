# Clara software plan — HackPrinceton build (proposed)

**Historical plan from 2026-11-12.** Code now exists, and this offline-first/touch-navigation build plan was superseded by the [current feature list](feature-list.md), [voice guide](voice.md), and [conversation runtime](conversation-runtime.md). Keep the milestone ideas below as history; do not use them to implement Next/Back/Repeat controls or assume offline speech understanding. Clara is a proof of concept and will never be used on a patient.

## The story and what it changes

Clara boxes are meant for places with no reliable access to doctors or ambulances: conflict zones, refugee camps, and high-poverty or remote areas. Bystanders are the first and sometimes only responders. Clara bridges the gap **until someone can reach care**. It does not replace doctors.

| Earlier assumption | Now |
| --- | --- |
| Cloud agent, offline as fallback | **Offline first.** Every life-critical path runs on the box with no internet. Claude makes the conversation smarter when a link exists. |
| 911 or EMS is coming | There may be no ambulance. "Call for help" means alerting **nearby boxes and a local hub** at a clinic, community health worker, or NGO compound. The demo contacts no emergency service. |
| Cloud backend | A **local hub** (a laptop) that syncs to the cloud only when a link exists (store and forward). |
| English | **Several languages, pictogram first**, usable without reading. |
| One patient | **Mass-casualty events are likely**, so START triage is a core feature. |
| Normal privacy | **Safety-critical privacy.** Casualty and location data could put people at risk: minimize, encrypt, keep local by default. |
| Mains power | Low-power idle and battery; solar later. |

## Architecture

```text
 ┌────────────────────── BOX (Pi 5) ───────────────────────┐
 │  box-ui (kiosk browser)  ←WebSocket→  box-core (Node TS)  │
 │                                       ├ protocol engine  │
 │  ESP32 ←USB serial→ hw-bridge ────────┤ event log (SQLite)│
 │  (lid, LEDs, buzzer, mount)           ├ voice pipeline   │
 │                                       ├ AI router ───────┼──→ Claude (when online)
 │  mic / speaker / camera ──────────────┤   └ offline mode │
 │                                       ├ supply ledger    │
 │                                       └ sync outbox ─────┼──→ HUB
 └──────────────────────────────────────────────────────────┘
                               │ Wi-Fi (demo) / LoRa mesh (stretch)
 ┌──────────── HUB (laptop at the "clinic") ────────────────┐
 │  hub-server (FastAPI + WebSocket + SQLite)               │
 │  dashboard: map, incidents, timeline, triage board,      │
 │  handoff, supply ledger and restock, alerts              │
 └──────────────────────────────────────────────────────────┘
```

Everything is an **event** in an append-only log on the box (`lid.opened`, `step.shown`, `triage.patient_tagged`, `sos.opened`, `supply.usage_confirmed`). The timeline, handoff card, triage board, and supply counts are all derived from that log, which syncs to the hub whenever a link exists. Event shapes follow [contracts](contracts.md).

## Components

### 1. ESP32 firmware (`firmware/`, Arduino via PlatformIO)
Lid switch, mount switch, compartment LEDs, buzzer. Newline-delimited JSON over USB serial. It only reports switch states and obeys bounded commands. See [firmware](subsystems/firmware.md).

### 2. box-core (`box/`, TypeScript on Node on the Pi)
- **hw-bridge:** serial in and out, converts lines to events.
- **Protocol engine:** a state machine per scenario, loaded from YAML, that knows the allowed next steps at each point. **It works with touch alone**, which is what makes offline mode real.
- **Event log:** append-only SQLite, plus an outbox table for sync.
- **Voice pipeline:** see [voice](voice.md). Hands-free voice-activity detection, a server that runs Cartesia speech-to-text, Claude and Cartesia text-to-speech, **pre-recorded audio for every scripted step** in each language, and Piper or espeak-ng on the box as a fallback voice. A scaffold exists in `server/` and `box/`; whisper.cpp offline speech is a later option.
- **AI router:** Claude when online, offline mode otherwise (see below).
- **Supply ledger:** running stock per slot, see [kit inventory](subsystems/kit-inventory.md).
- **Local API:** WebSocket to the UI; the box pushes state and the UI sends taps.

### 3. box-ui (`box-ui/`, TypeScript in kiosk Chromium)
Language picker first (flags plus spoken names). Big pictograms, one step at a time, Next, Back, Repeat. Always-visible **SOS** and **Multiple injured → Triage**. Handoff card, nearby-box alert, offline indicator, end-of-session supply confirmation. Designed for the 5-inch 800×480 screen; right-to-left support if a language needs it. See [touchscreen UX](subsystems/touchscreen-ux.md).

### 4. Content bundles (`content/`)
```text
content/scenarios/severe_bleeding.yaml   # steps, branches, item slots, source links
content/scenarios/start_triage.yaml
content/audio/<lang>/<step_id>.mp3
content/images/<step_id>.svg
```
Written from the sources in [demo safety](medical-safety.md) and checked by a teammate. **The AI can only choose steps from these files; it never writes medical instructions.**

### 5. Hub and dashboard (`hub/` Python FastAPI, `dashboard/` TypeScript)
Box registry and heartbeats, incident list, live timeline, triage board (red, yellow, green, black), handoff cards, supply ledger and restock, security flags. **The map is a static image** of a fictional camp or village with box pins, not online map tiles. The dashboard replaces the companion phone app for this build. See [box network](subsystems/box-network.md).

### 6. Box ↔ hub link
- **Demo:** local Wi-Fi from a travel router or hotspot. Unplug the router's internet and show that everything still works.
- **Stretch:** two LoRa boards running Meshtastic (for example Heltec V3) carrying SOS and box alerts off grid.

## AI design

### Online: Claude
- **Model:** `claude-opus-5-5` at `effort: "low"`, streaming, for voice latency. If measured latency is too slow, compare `claude-haiku-5-5` on the same evaluation set before switching.
- **Each turn** sends the conversation plus the engine's **allowed next steps**. Claude answers by calling one tool:
  - `select_step(step_id)`: `step_id` is an enum of the currently allowed steps; anything else is rejected.
  - `ask_clarifying(question_id)`: chooses from pre-written questions.
  - `inventory.locate(sku)`: lights the matching compartment.
  - `inventory.record_usage(items)`: end-of-session supply report, see below.
  - `camera.capture_once(purpose)`: one consented frame.
  - `start_triage()` / `tag_patient(patient_n, answers)`.
- **API notes:** this model rejects forced tool choice, so use `tool_choice: auto` with `strict: true` on every tool and instruct the model to always call a tool. Cache the fixed system prompt and scenario catalog. Handle the `refusal` stop reason and enable server-side fallbacks.
- **Vision** returns only an observation with uncertainty; a frame never advances a step by itself.
- **SOS and network alerts are deterministic code.** The AI can suggest SOS; only a tap or the scenario's SOS step opens it.

The full tool contract is in [agent runtime](agent-runtime.md).

### Offline
- Touch first, with the same state machine, LEDs, and pre-recorded audio.
- Simple voice: whisper.cpp plus a small keyword set per language ("bleeding," "not breathing," "next," "repeat").
- A local LLM (1–3B on a 4 GB Pi) is the production path, **not** promised in the demo.

## Demo script (about 3 minutes)
1. **Setup:** "A village clinic two hours from the nearest hospital. No ambulance. Connectivity comes and goes."
2. The lid opens and the box chimes. Choose a language and say "my brother's leg is bleeding badly" (online, Claude).
3. The tourniquet compartment lights; illustrated steps play with voice.
4. Tap SOS. **The clinic dashboard** shows the incident, live timeline, and handoff card. **Box B** across the room lights up: "bring this kit."
5. **Pull the internet.** The box keeps guiding by touch and pre-recorded audio, and alerts still reach the hub over local Wi-Fi.
6. "There are more injured" starts triage; the dashboard triage board fills in.
7. End of session: "What did you use?" The box confirms the supplies, and the hub shows a restock alert.
8. **Close:** cost per box, NGO deployment model, LoRa and solar next.

## Team split

| Person | Owns |
| --- | --- |
| 1. Hardware | Enclosure, wiring, ESP32 firmware, hw-bridge |
| 2. Box brain | Protocol engine, event log, AI router and Claude tools, voice pipeline, supply ledger |
| 3. Box UI and content | box-ui, scenario YAML, illustrations, audio in both languages |
| 4. Hub | hub-server, dashboard, sync, Box B, network |

## Build order (36 hours)

| Hours | Goal | Done means |
| --- | --- | --- |
| Before the event | Content and setup | Scripts drafted and checked, parts bench-tested, accounts and keys ready. Ask organizers what may be prepared ahead. |
| 0–4 | Skeletons talk | Event types frozen; lid opens and the UI appears over serial; the box sends one event to the hub. |
| 4–12 | **Minimum demo, offline** | Bleeding scenario end to end by touch, with LEDs and audio. This alone is a demo if everything else fails. |
| 12–20 | Smart and connected | Voice plus Claude selecting steps; SOS reaches the hub; dashboard timeline; Box B alert. |
| 20–26 | Story features | Triage, handoff card, second language, the "pull the internet" moment, supply ledger and restock alert. |
| 26–30 | Extras | Camera frame, open chime and snapshot, evaluation set, sponsor integrations. |
| 30–36 | **Freeze** | Bug fixes only; rehearse five or more times; record a backup video. |

**Cut first if behind:** pulse sensor, GPS, LoRa, mount switch, camera vision, second language, sponsor integrations. **Keep:** offline touch flow, SOS to hub, Box B, triage.

## Proposed repository layout
```text
firmware/    ESP32 (PlatformIO)
box/         Pi services (TypeScript): bridge, engine, voice, ledger, sync
server/      voice turn server (TypeScript): speech-to-text, Claude, text-to-speech
packages/    shared contracts (TypeScript)
box-ui/      on-box screen (TypeScript)
hub/         local hub server (Python)
dashboard/   clinic or NGO dashboard (TypeScript)
content/     scenarios, audio, images
contracts/   JSON Schemas for events
```
This replaces the earlier `device/`, `cloud/`, `touchscreen/`, `app/` map in the [README](../README.md) once the team agrees.

Sponsor prize targets are in [sponsors](sponsors.md).

## Open decisions
1. Agree on the low-resource story and offline-first architecture.
2. Choose the second language and a fluent teammate to record and check it.
3. Keep or drop the MAX30102 pulse sensor.
4. Claude through the Anthropic API directly or through Amazon Bedrock (see [sponsors](sponsors.md)).

# Clara feature list (current source of truth)

**Updated 2026-11-13 at the start of HackPrinceton.** This list supersedes older planning docs in this folder where they disagree (those were written before the event; see "What changed" at the end). Labels: **must** (the core loop), **should**, **stretch**.

**ESP32 build status:** the current three-light board profile has been built and flashed with a Pi-compatible USB serial protocol. Pi hello, a fresh raw sensor result and null BPM with no finger are verified on the connected board. The owner visually verified all three physical LEDs with the integrated firmware after its lease-clock fix: top-left small, top-right medium and bottom large. The 22 stocked supply categories are mapped to those slots in `content/kits/clara-3slot-v1.json`; exact quantities, lots and expiry remain unverified. The Pi and ESP32 were updated and reconnected on 2026-11-14. A steady on-finger BPM remains unverified; see [firmware](../firmware/README.md).

## The story

Clara is a network of AI-assisted first-aid boxes for places where professional help is far away: conflict zones, refugee camps, and high-poverty or remote areas. Opening a box enables a conversation; a user request can lead to a relevant visual, a verified item location, or a demo network action. The agent may continue talking while independently authorized background tasks run. Clara does not replace doctors. A Starlink-connected site is a proposed deployment story, not a measured property of the demo. The current box has no general offline voice conversation.

## Current interaction direction (2026-11-13)

**Demo implemented:** the Pi receives the ESP32 lid event; the lid shows and plays a fixed Cartesia greeting, then opens a voice session without contacting the model. A final utterance requests a cloud turn. Closing the lid stops voice and blanks the screen to black; touching the black screen reveals SOS and Mute Clara for 15 seconds. The local screen can render answer, question, item-location, approved-illustration, and versioned-guidance cards; item light and mock SOS are implemented. The screen exposes visuals, voice status, a 911 Guide button, and speaker mute, with no step navigation or Talk button. The nearby-emergency banner and interruptive alert are hidden. **Demo verified on Pi:** the owner heard the exact greeting and the item light cue, saw the larger item diagram and 911 Guide label, and observed the top-left light after asking for scissors. The box/kiosk services and ESP32 hello are active at `3023a0a`; black-screen wake and mute still need a focused physical check.

**Demo implemented:** a separate response coordinator can delegate to responder-scout, logistics, and time-to-care subagents when `CLARA_COORDINATOR=on` and a model key is available. It serves the dispatch console and never speaks to the box user or calls 911. A separate mock emergency worker collects fixed facts after SOS; it asks through the existing Clara voice and accepts only a same-session, source-linked answer. This bridge still needs physical verification. **Demo implemented in code:** one Core Clara voice uses bounded cross-turn context and launches scoped mock emergency, pulse, and camera tasks from user requests or direct SOS. A local, fixed-template on-box handoff card and a draft not-breathing scenario with CPR rhythm coach are also implemented in code; neither has a physical end-to-end check. **Proposed:** a broader task supervisor and authorized real caller. Generated treatment diagrams, synchronized speech segments, and the broader Core Clara task bus remain unimplemented; see [conversation runtime](conversation-runtime.md).

**Demo implemented in code, physical check pending:** Core Clara now keeps bounded server-side turn context and source-labeled prior reports, selects one validated action per spoken turn, and can start independent pulse and consented single-frame camera jobs on the Pi. These jobs return screen results without blocking the conversation; mock emergency fact collection and responder coordination remain separate workers. The camera route requires matching `CLARA_BOX_TOKEN` on Pi and server plus an Anthropic key. A general multi-call planner and real 911 dialing remain future work.

## Request-driven core loop

Someone opens the box → the mic becomes available without automatically contacting the model → they ask Clara for help → Clara responds and can show relevant information or locate an item → SOS remains directly available → a volunteer may accept through the demo network → the box says who is coming only after acceptance.

## Must

**The box**
1. **Lid opens → conversation becomes available.** ESP32 limit switch tells the always-on Pi over USB serial; a closed lid means voice is off. Opening alone never requests an agent turn.
2. **Hands-free conversation.** Mic listens while the lid is open; voice-activity detection ends each utterance. There is no on-screen Talk control.
3. **Versioned guidance and flexible visuals.** Current code can select a scenario panel, eight original kit/equipment illustrations, or the guarded `minor-cut-demo-v1/rinse_cover` visual by ID. The minor-cut visual and new `not_breathing/draft-1` scenario await teammate content review. The Core can present an answer, question, diagram, item location, or hardware reading within source and provenance checks; the local on-box handoff card uses fixed templates from session events.
4. **Lit compartments.** When a verified item is requested, its mapped LED can light; guidance may also locate an item.
5. **Minimal touchscreen.** It displays agent-selected visuals, captions and status, with **simulated SOS** and **Mute Clara** controls. The closed-lid screen is black and wakes to reveal SOS on touch. No Next / Back / Repeat or branch controls are shown.
6. **Runs on the 12 V battery** (power path to the Pi still needs a bench test; keep the official Pi supply as backup).

**SOS and help**
7. **Mock SOS.** 5 s countdown (tap to cancel) → a **simulated 911 call** screen with coaching. When configured, Twilio can ring a team-owned demo dispatcher phone once and read a one-time briefing from events known then; subsequent fact-worker answers are not included. No emergency number is dialed. Twilio acceptance is not proof that a person answered. Phone delivery has not been verified on the deployed demo.
8. **Companion app = the response network.** Volunteer sign-up by QR (skills, vehicle, language, location); alerts for nearby emergencies (also over WhatsApp/iMessage through Photon); **Accept / Decline** with the handoff card and directions; the kit map; two-way messages that the box reads aloud.
9. **The box says who is coming, honestly.** "Amina, a nurse, about 6 minutes" only after Amina accepted; names and times come from templates, never from the model.
10. **Nearby boxes join (not shown on the current kiosk).** The network contract can deliver another box's incident, but the kiosk does not announce it or show an emergency-nearby banner.
11. **Honesty rule in code.** No "help is coming" before an accept, no diagnoses, no false comfort ("he'll be fine"), no advice outside the approved steps.

**Dashboards**
12. **Clinic / dispatch dashboard.** Map, live timeline, triage board, responder status.
13. **Scene report for EMS.** The server exposes a token-based report and a six-character short link shown as text on the box after the mock incident opens; no QR is displayed. The broader MIST report, photos, and sharing checks need separate review. `timer.started` only means the box started a guidance timer, and `step.done` only means navigation advanced; neither confirms treatment.
14. **On-box handoff card (demo implemented in code; physical check pending).** A Show / Read Summary control during mock SOS builds and speaks fixed MIST-style lines from this box's own session events, even offline. Reports stay labeled as bystander reports, guidance as steps shown, and valid pulse values as device readings; it does not assert treatment occurred.
15. **Maintainer backend.** Box status and heartbeat, restock alerts, supply counts, anti-theft flags, boxes that went offline.

## Should
16. **Kit map, Lime-style.** Pins by status (ready / low / in use / offline) with last-updated time, directions, "I'm grabbing it"; in the companion app and on the box.
17. **Escalation.** No reply in 60 s → next helper → everyone with the skill → dashboard flags it.
18. **Multi-patient START triage**, with the board on the dashboard.
19. **Running supply count (proposed).** "What did you use?" → an agent proposes a list → a future confirmation method approves it → restock alert. The current model does not offer usage changes because the minimal screen has no confirmation control.
20. **Camera check (demo implemented in code; end-to-end physical check pending).** On request and with session consent, the Pi captures one USB-camera frame for a cloud observation. The result carries uncertainty and never advances guidance by itself.
21. **Failure states.** Server or internet down, item missing, kit layout mismatch, stale or offline box, a volunteer cancels: the box shows what it knows and keeps local mock SOS available. General offline conversation is not implemented.
22. **Second language** (Claude speaks freely only in languages a teammate checked; elsewhere fixed recorded lines).
23. **First-aid voice exam.** Simulated panicked bystanders, an Opus grader, results (including failures) in the README.
24. **Approved answers** to common questions; below a match threshold, Clara asks for clarification or says it does not know.
25. **Pulse sensor (demo implemented in code; valid on-finger BPM pending).** A fresh MAX30102 sample window can yield an ESP32 pulse estimate; the Pi shows a number only for a valid-quality result, otherwise a specific unavailable or unstable-signal message. A direct on-finger check received 11 hardware reports, all `suspect`; raw optical sampling and USB were confirmed, but no numeric BPM has been verified against an independent reference. It cannot select treatment. Scene-report/dashboard integration remains proposed.

## Stretch
26. Ride matching for patient transport (one accept wins).
27. **Demo implemented in code:** opted-in volunteers can receive a Twilio phone fallback after an unseen alert; call delivery still needs a deployed end-to-end check. This is separate from the optional team-owned simulated 911 briefing in #7.
28. **Demo implemented:** deepagents response coordinator with responder-scout, logistics, and time-to-care specialists, subject to its configuration and tool limits. It is distinct from the proposed emergency caller and Core Clara task supervisor.
29. ~~Driver fuel reimbursement through Nessie (Capital One prize)~~ — dropped, not targeting Capital One.
30. **Demo implemented in code, live planner check pending:** the Admin app has a CoStar/Matterport/Vexcel kit-placement planner and network health view. Its data and planning APIs require `CLARA_ADMIN_TOKEN`; external source keys and a real building-data check are still needed for a useful live plan.
31. Anti-theft: open chime, snapshot, wall-mount alert.
32. Live video feed to EMS.

**Brainstormed favorites, not yet committed:** hackathon mini study (tourniquet with vs without Clara), QR triage tags, training mode, continue-on-your-phone QR, "is anyone here a doctor or nurse?" announcement, walking blood bank, emergency childbirth guide, simulated village on the dashboard. **Demo implemented in code, physical check pending:** draft not-breathing scenario and 110 bpm CPR coach with ESP32 LED rhythm, generated audio ticks that pause for speech, fixed spoken reminders, a screen beat count, and a Stop control. The count is derived from elapsed beats, not observed compressions. A missing pulse reading prompts the bystander to check responsiveness and breathing; the sensor alone never starts CPR.

**Deferred:** local offline AI and LoRa. Privacy controls remain required for any consented media or health-data handling. **Demo implemented:** a USB u-blox 7 GNSS receiver is attached to the Pi and a local parser accepts fresh, valid NMEA RMC fixes for mock SOS coaching. If no valid fix is available, it shows `Configured box address: 1455 California Ave`. No location is sent to cloud or volunteers by that path. **Demo verified on Pi:** the receiver emitted a valid RMC/GGA fix and the deployed service connected to its USB port. End-to-end mock SOS location presentation remains unverified.

## Tech stack
- **TypeScript everywhere** (Node 24), npm workspaces.
- **Box (Pi 5):** Node service; `arecord`/`aplay` audio (same mic and speaker as Sophi); USB serial to the ESP32; Piper/espeak-ng fallback voice; box screen as a local web page in Chromium kiosk.
- **ESP32:** Arduino/PlatformIO C++, newline-delimited JSON over USB serial (lid switch, LEDs, pulse sensor).
- **Backend + web:** one Next.js app (box API, companion app, dashboard, maintainer backend, kit map, EMS scene report). Runtime state is held in memory and snapshotted to Render Postgres when `DATABASE_URL` is set; local development without that variable is memory-only. See [persistence](persistence.md).
- **AI:** Anthropic SDK; Claude Haiku 5.5 main with Claude Opus 5.5 as a parallel backup; structured JSON replies with the schema rebuilt each turn.
- **Voice:** Cartesia (ink-whisper speech-to-text, Sonic voice). Key lives only in the server's environment.
- **Messaging:** Photon 2.0 (iMessage / WhatsApp); optional Twilio volunteer fallback and team-owned demo dispatcher call. Neither calls emergency services.
- **Maps:** Leaflet + OpenStreetMap, or a static map of a fictional village.

## Reuse from Sophi
The organizers confirmed we may adapt code from our Cal Hacks 13.0 project Sophi with credit. Pi audio, speech queue, serial protocol, firmware patterns, simulator, Pi install script, Cartesia clients, the Claude call wrapper, the main/backup hedge, and the help-request lifecycle (sent / shown / coming / closed) come from Sophi; every adapted file says so at the top.

## What changed from the older docs here
Older docs in this folder (written before the event) describe offline-first with a local hub, a fictional responder preview, and a mock-only network. Now: Starlink plus a cloud backend; a real volunteer network through the companion app; mock **911** only; MIST scene report for EMS; maintainer backend; Lime-style kit map.

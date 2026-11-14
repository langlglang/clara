# Clara feature list (current source of truth)

**Updated 2026-11-13 at the start of HackPrinceton.** This list supersedes older planning docs in this folder where they disagree (those were written before the event; see "What changed" at the end). Labels: **must** (the core loop), **should**, **stretch**.

**ESP32 build status:** the current three-light board profile has been built and flashed with a Pi-compatible USB serial protocol. Pi hello, LED commands, a fresh raw sensor result and null BPM with no finger are verified on the connected board. A steady on-finger BPM, the installed lid mechanism and six-compartment layout are not yet verified; see [firmware](../firmware/README.md).

## The story

Clara is a network of AI-assisted first-aid boxes for places where professional help is far away: conflict zones, refugee camps, and high-poverty or remote areas. Opening a box enables a conversation; a user request can lead to a relevant visual, a verified item location, or a demo network action. The agent may continue talking while independently authorized background tasks run. Clara does not replace doctors. A Starlink-connected site is a proposed deployment story, not a measured property of the demo. The current box has no general offline voice conversation.

## Current interaction direction (2026-11-13)

**Demo implemented:** the Pi receives the ESP32 lid event; the lid opens a voice session, and a final utterance requests a cloud turn. Closing the lid stops voice. The local screen can render answer, question, item-location, and versioned-guidance cards; item light and mock SOS are implemented. The screen exposes visuals, status, and simulated SOS, with no step navigation or Talk button. **Demo verified on Pi:** commit `f83cc43` runs with active box/kiosk services, ESP32 hello, GPS serial connection, and an 800 × 480 idle screen showing MIC OFF and SOS. A live lid-open conversation and generated card on the physical screen remain unverified.

**Proposed:** Core Clara is one continuous user-facing conversation while the lid is open. It invokes tools and launches background emergency, responder, handoff, and evidence jobs only after real triggers. The screen shows whichever approved visual helps the current request, not a required sequence of steps. Generated diagrams, reading and handoff cards, synchronized speech segments, and background agents are not yet implemented; see [conversation runtime](conversation-runtime.md).

## Request-driven core loop

Someone opens the box → the mic becomes available without automatically contacting the model → they ask Clara for help → Clara responds and can show relevant information or locate an item → SOS remains directly available → a volunteer may accept through the demo network → the box says who is coming only after acceptance.

## Must

**The box**
1. **Lid opens → conversation becomes available.** ESP32 limit switch tells the always-on Pi over USB serial; a closed lid means voice is off. Opening alone never requests an agent turn.
2. **Hands-free conversation.** Mic listens while the lid is open; voice-activity detection ends each utterance. There is no on-screen Talk control.
3. **Approved guidance and flexible visuals.** Current code can select a versioned scenario panel. The proposed core agent can present a relevant answer, question, diagram, item location, reading, or handoff card, within source and provenance checks.
4. **Lit compartments.** When a verified item is requested, its mapped LED can light; guidance may also locate an item.
5. **Minimal touchscreen.** It displays agent-selected visuals, captions and status, with always-visible **simulated SOS**. No Next / Back / Repeat or branch controls are shown.
6. **Runs on the 12 V battery** (power path to the Pi still needs a bench test; keep the official Pi supply as backup).

**SOS and help**
7. **Mock SOS.** 5 s countdown (tap to cancel) → a **simulated 911 call** screen ("Calling 911 — simulation"); the screen coaches what to say; the scene report is ready for EMS. Clara never really dials 911.
8. **Companion app = the response network.** Volunteer sign-up by QR (skills, vehicle, language, location); alerts for nearby emergencies (also over WhatsApp/iMessage through Photon); **Accept / Decline** with the handoff card and directions; the kit map; two-way messages that the box reads aloud.
9. **The box says who is coming, honestly.** "Amina, a nurse, about 6 minutes" only after Amina accepted; names and times come from templates, never from the model.
10. **Nearby boxes join.** Box B lights up: "Emergency at Room 101, bring this kit."
11. **Honesty rule in code.** No "help is coming" before an accept, no diagnoses, no false comfort ("he'll be fine"), no advice outside the approved steps.

**Dashboards**
12. **Clinic / dispatch dashboard.** Map, live timeline, triage board, responder status.
13. **Scene report for EMS.** MIST summary (Mechanism, Injuries, Signs, Treatment), tourniquet time, timeline, photos. Paramedics scan a QR code on the box screen. Every fact is labeled reported / observed / done; code checks each line against the event log.
14. **On-box handoff card** for whoever walks up.
15. **Maintainer backend.** Box status and heartbeat, restock alerts, supply counts, anti-theft flags, boxes that went offline.

## Should
16. **Kit map, Lime-style.** Pins by status (ready / low / in use / offline) with last-updated time, directions, "I'm grabbing it"; in the companion app and on the box.
17. **Escalation.** No reply in 60 s → next helper → everyone with the skill → dashboard flags it.
18. **Multi-patient START triage**, with the board on the dashboard.
19. **Running supply count (proposed).** "What did you use?" → an agent proposes a list → a future confirmation method approves it → restock alert. The current model does not offer usage changes because the minimal screen has no confirmation control.
20. **Camera check.** "Show me the wound": one photo; the model describes it with its uncertainty and never advances a step from it alone.
21. **Failure states.** Server or internet down, item missing, kit layout mismatch, stale or offline box, a volunteer cancels: the box shows what it knows and keeps local mock SOS available. General offline conversation is not implemented.
22. **Second language** (Claude speaks freely only in languages a teammate checked; elsewhere fixed recorded lines).
23. **First-aid voice exam.** Simulated panicked bystanders, an Opus grader, results (including failures) in the README.
24. **Approved answers** to common questions; below a match threshold, Clara asks for clarification or says it does not know.
25. **Pulse sensor (MAX30102).** Finger clip → ESP32 → pulse with time on screen, in the scene report and dashboard, labeled "device reading". Show a number only after the detection code is tested; otherwise "unavailable". The model may read it out but never chooses a step from it.

## Stretch
26. Ride matching for patient transport (one accept wins).
27. Phone calls to helpers without smartphones (Twilio + Cartesia).
28. deepagents coordinator (LangChain prize).
29. Driver fuel reimbursement through Nessie (Capital One prize).
30. CoStar kit-placement agent (only with a free person after a one-hour data check).
31. Anti-theft: open chime, snapshot, wall-mount alert.
32. Live video feed to EMS.

**Brainstormed favorites, not yet committed:** hackathon mini study (tourniquet with vs without Clara), CPR coach with LED rhythm, tourniquet timer, QR triage tags, training mode, continue-on-your-phone QR, "is anyone here a doctor or nurse?" announcement, walking blood bank, emergency childbirth guide, simulated village on the dashboard.

**Deferred:** local offline AI and LoRa. Privacy controls remain required for any consented media or health-data handling. **Demo implemented:** a USB u-blox 7 GNSS receiver is attached to the Pi and a local parser accepts fresh, valid NMEA RMC fixes for mock SOS coaching. If no valid fix is available, it shows `Configured box address: 1455 California Ave`. No location is sent to cloud or volunteers by that path. **Demo verified on Pi:** the receiver emitted a valid RMC/GGA fix and the deployed service connected to its USB port. End-to-end mock SOS location presentation remains unverified.

## Tech stack
- **TypeScript everywhere** (Node 24), npm workspaces.
- **Box (Pi 5):** Node service; `arecord`/`aplay` audio (same mic and speaker as Sophi); USB serial to the ESP32; Piper/espeak-ng fallback voice; box screen as a local web page in Chromium kiosk.
- **ESP32:** Arduino/PlatformIO C++, newline-delimited JSON over USB serial (lid switch, LEDs, pulse sensor).
- **Backend + web:** one Next.js app (box API, companion app, dashboard, maintainer backend, kit map, EMS scene report). Database and real-time: Supabase (in-memory store until the project exists).
- **AI:** Anthropic SDK; Claude Haiku 5.5 main with Claude Opus 5.5 as a parallel backup; structured JSON replies with the schema rebuilt each turn.
- **Voice:** Cartesia (ink-whisper speech-to-text, Sonic voice). Key lives only in the server's environment.
- **Messaging:** Photon 2.0 (iMessage / WhatsApp). Optional Twilio.
- **Maps:** Leaflet + OpenStreetMap, or a static map of a fictional village.

## Reuse from Sophi
The organizers confirmed we may adapt code from our Cal Hacks 13.0 project Sophi with credit. Pi audio, speech queue, serial protocol, firmware patterns, simulator, Pi install script, Cartesia clients, the Claude call wrapper, the main/backup hedge, and the help-request lifecycle (sent / shown / coming / closed) come from Sophi; every adapted file says so at the top.

## What changed from the older docs here
Older docs in this folder (written before the event) describe offline-first with a local hub, a fictional responder preview, and a mock-only network. Now: Starlink plus a cloud backend; a real volunteer network through the companion app; mock **911** only; MIST scene report for EMS; maintainer backend; Lime-style kit map.

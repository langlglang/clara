# Clara feature list (current source of truth)

**Updated 2026-11-13 at the start of HackPrinceton.** This list supersedes older planning docs in this folder where they disagree (those were written before the event; see "What changed" at the end). Labels: **must** (the core loop), **should**, **stretch**.

**ESP32 build status:** the current three-light board profile has been built and flashed with a Pi-compatible USB serial protocol. Pi hello, LED commands, a fresh raw sensor result and null BPM with no finger are verified on the connected board. A steady on-finger BPM, the installed lid mechanism and six-compartment layout are not yet verified; see [firmware](../firmware/README.md).

## The story

Clara is a network of AI-guided first-aid boxes for places where professional help is far away: conflict zones, refugee camps, and high-poverty or remote areas. Open a box and an AI talks you through treating the injury, lights the compartment holding what you need, and calls a network of nearby trained volunteers to the scene. Clara bridges the gap **until someone can reach care**; it does not replace doctors. Sites connect over **Starlink** (one terminal per site, boxes on local Wi-Fi); the life-critical steps still work by touch if the link drops.

## The core loop (build this first)

Someone opens the box → the AI guides them through first aid with voice, screen and lit compartments → they hit SOS → a volunteer on the companion app accepts → the box says who is coming → the dashboard shows it all.

## Must

**The box**
1. **Lid opens → box wakes.** ESP32 limit switch tells the always-on Pi over USB serial; the screen and voice start immediately.
2. **Hands-free voice guide**, plus an on-screen Talk button. Mic listens while a session is active; voice-activity detection ends each clip.
3. **The AI picks from approved steps only.** Claude chooses a `step_id` from the scenario's allowed next steps; each step has pre-recorded audio and a picture, played on the box.
4. **Lit compartments.** The LED beside the needed item lights for that step.
5. **Touchscreen backup.** Pictogram steps, Next / Back / Repeat, always-visible **SOS** and **Multiple injured**.
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
19. **Running supply count.** "What did you use?" → the model proposes a list → tap to confirm → restock alert. No weight or slot sensors.
20. **Camera check.** "Show me the wound": one photo; the model describes it with its uncertainty and never advances a step from it alone.
21. **Failure states.** Server or internet down, item missing, kit layout mismatch, stale or offline box, a volunteer cancels: the box always says what it knows and keeps guiding.
22. **Second language** (Claude speaks freely only in languages a teammate checked; elsewhere fixed recorded lines).
23. **First-aid voice exam.** Simulated panicked bystanders, an Opus grader, results (including failures) in the README.
24. **Approved answers** to common questions; below a match threshold, "I don't know, follow the screen."
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

**Dropped:** box GPS, local offline AI, LoRa, privacy work (for the demo).

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

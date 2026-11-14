# Clara

**AI-guided first-aid boxes that bring a network of nearby help to the scene.** HackPrinceton Fall 2026, Healthcare track.

Where professional help is far away (conflict zones, refugee camps, remote and high-poverty areas), the first responder is whoever is standing nearby. Clara is a box on the wall: open it and talk to an AI about what is needed. It can show a relevant visual, light the compartment holding a requested item, and coordinate a demo response network. The box only says someone is coming once a real person has accepted. A scene report can separate what was reported, observed, and done.

> Clara is a hackathon proof of concept. It is never used on a patient, the demo scenarios are fictional, and the 911 call is simulated.

## Live demo

**https://clara.living** (hosted on Render's free plan: the first visit after 15 idle minutes takes about a minute to wake it; state is saved to Postgres, so restarts and redeploys keep it)

| Page | Link |
| --- | --- |
| Companion app (volunteers' phones) | https://clara.living/app |
| Join the network | https://clara.living/join |
| Dispatch and rides console | https://clara.living/dashboard |
| Network and boxes console | https://clara.living/maintainer |
| Kit map | https://clara.living/map |

A real box connects by setting `CLARA_SERVER_URL=https://clara.living` in `/etc/clara-box.env` on the Pi (see `box/scripts/systemd/clara-box.env.example`).

## What's in the repo

| Path | What it is |
| --- | --- |
| `packages/contracts` | Shared types (zod): box events, scenarios, voice turns, the response network, ESP32 serial messages |
| `packages/agent` | Bounded Core Clara voice loop: Cartesia speech-to-text → Claude (Haiku 5.5, Opus 5.5 backup) picks one allowed action per turn → Cartesia voice, with source-labeled context across turns and background pulse, camera, and mock emergency tasks. The broader multi-call planner is proposed in [conversation-runtime](docs/conversation-runtime.md). |
| `packages/network` | Incidents, volunteer matching, alerts (sent → shown → coming → arrived), escalation, the EMS scene report, box status, supply ledger |
| `packages/coordinator` | The response coordinator: a LangChain **deepagents** agent that plans the human response per incident (write_todos plan, `responder-scout`, `logistics` and `time-to-care` subagents, notes in its virtual filesystem) through bounded tools; a no-key rules planner for demos |
| `apps/web` | Next.js: box API, companion app (`/app`), dispatch dashboard, EMS scene report, kit map, maintainer backend |
| `box` | Raspberry Pi service: hands-free audio, voice loop, scenario engine, kiosk screen, SOS and mock-911 flow, cloud link, ESP32 link, simulator, self-test |
| `firmware` | ESP32 (PlatformIO): lid and mount switches, compartment LEDs, CPR rhythm, buzzer, MAX30102 pulse sensor |
| `content` | Scenarios (severe bleeding, draft) and the kit layout |
| `docs` | Design docs; start with [feature list](docs/feature-list.md) and [conversation runtime](docs/conversation-runtime.md) |

## Run it

```bash
npm install
npm test
npm run typecheck
```

Box simulator (no hardware, fake cloud; screen at http://127.0.0.1:8787):

```bash
npm run sim -w @clara/box
```

Web app (http://localhost:3000):

```bash
npm run web
```

Box against the local web app:

```bash
npm run sim -w @clara/box -- --server http://localhost:3000
```

Keys (`ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`) go in `apps/web/.env.local`, never in the repo or on the box. `CLARA_MODEL=stub` runs the voice brain without keys.

## Response coordinator (deepagents)

For each open emergency a LangChain [deepagents](https://github.com/langchain-ai/deepagentsjs) agent (Claude Opus 5.5) plans the human response: it writes a todo plan, asks a `responder-scout` subagent who else to alert and a `logistics` subagent about a second kit or a ride to hospital, and a `time-to-care` subagent whether the simulated ambulance gets the patient to hospital in time, then acts through tools whose limits are enforced in code (at most 3 alerts per call and 6 extra per incident, only listed candidates; kits only from boxes within 1.5 km that are online; ride proposals still need the dispatcher). **Time to care:** code compares the simulated 911 call's ambulance (`CLARA_AMBULANCE_ETA_MIN`, a demo setting, plus 15 min on scene and the drive to the nearest fictional hospital) with the best free volunteer driver (pickup, 5 min loading, same drive) against the scenario's demo deadline (`care.reach_hospital_within_min`; defaults bleeding 60, breathing 30, general 120 min; fictional, not medical guidance). When the ambulance would be late and a driver is at least 10 min faster, `request_ride` sends ride offers to the two best drivers at once (push, call fallback, first accept wins), once per incident; the dispatcher can cancel or reassign. It never talks to the bystander or the box voice, never closes incidents, never marks anyone coming, and never contacts emergency services. The dispatch console shows its plan, actions with reasons, notes and needs-a-human flags.

`CLARA_COORDINATOR=on` (default) runs it when `ANTHROPIC_API_KEY` is set; `CLARA_COORDINATOR=rules` runs a deterministic planner with the same tools and no key; `off` disables it. Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` to trace runs in LangSmith. Details: [docs/coordinator.md](docs/coordinator.md).

## Volunteer app (PWA): alerts, drivers, phone calls

Volunteers join at [clara.living/join](https://clara.living/join): first aid nearby, driving patients to hospital (no medical skills needed), or both; then skills (self-reported), vehicle and seats, where they usually are with an alert radius (0.5–10 km), availability and quiet hours. The app installs to the home screen and gets loud push alerts with **I'M COMING / CAN'T** (or **I CAN DRIVE / CAN'T** for ride offers), even when closed. If an alert or ride offer is still unseen after 30 s, Clara can phone a volunteer who gave a number and agreed (press 1 / 2), once per alert, via Twilio.

- **iPhone:** push alerts only work after **Share → Add to Home Screen** and opening Clara from there (iOS 16.4+). In a Safari tab, alerts show only while the page is open.
- **Push keys:** set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (`npx web-push generate-vapid-keys`); without them the server generates a pair and keeps it in the database snapshot with the subscriptions (with no database, phones re-subscribe after each restart).
- **Calls:** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (and `PUBLIC_BASE_URL`, default `https://clara.living`). Without them calls are only logged and the maintainer console says "Calls: not configured". **A Twilio trial account can only call numbers verified in the Twilio console.** Clara never calls emergency services.
- **Texts:** volunteers can tick **Also text me (iMessage/WhatsApp/SMS)** and answer alerts by replying 1 / 2, via [Photon](https://photon.codes) (Beta API). Set `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_WEBHOOK_SECRET`; setup steps in [docs/companion-pwa.md](docs/companion-pwa.md#text-alerts-photon-imessage-whatsapp-sms). Without them texts are only logged.

Details: [docs/companion-pwa.md](docs/companion-pwa.md).

## Persistence (survives restarts and redeploys)

The server keeps everything in memory in one process and, when `DATABASE_URL` is set, snapshots it to Postgres: boxes, volunteers, events, incidents and alerts, rides, push subscriptions (and a generated VAPID pair), call bookkeeping and coordinator logs. It loads the snapshot before serving the first request, saves within about 2 s of a change (at most every 2 s) and once more on SIGTERM. Two instances during a deploy can't overwrite each other: a save only lands if no newer instance has saved. Without `DATABASE_URL` (local dev, tests) nothing changes. `/api/state` reports `persistence` and the maintainer console shows "Saved · 3 s ago" or "Not saving (no database)". On Render, `render.yaml` creates a free Postgres (it expires after 30 days). Details: [docs/persistence.md](docs/persistence.md).

## Credits

Parts of this repo are adapted from our Cal Hacks 13.0 project **Sophi** ([github.com/mzhao1599/sophi](https://github.com/mzhao1599/sophi)), with the HackPrinceton organizers' permission: Pi audio capture and playback, the speech queue, the serial protocol and firmware patterns, the screen server, the simulator, the Pi install and self-test scripts, the Cartesia clients, the Claude call wrapper and main/backup model hedge, and the help-request lifecycle behind the response network. Every adapted file says so at the top. Everything else was written during HackPrinceton.

Design ideas (not code) from Standard Response (Cal Hacks 13.0): an honesty rule enforced in code, a graded voice exam, and an escalation ladder.

First-aid content follows Stop the Bleed and Red Cross guidance and is marked draft until a teammate checks every step against the sources.

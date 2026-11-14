# Clara

**AI-guided first-aid boxes that bring a network of nearby help to the scene.** HackPrinceton Fall 2026, Healthcare track.

Where professional help is far away (conflict zones, refugee camps, remote and high-poverty areas), the first responder is whoever is standing nearby. Clara is a box on the wall: open it and talk to an AI about what is needed. It can show a relevant visual, light the compartment holding a requested item, and coordinate a demo response network. The box only says someone is coming once a real person has accepted. A scene report can separate what was reported, observed, and done.

> Clara is a hackathon proof of concept. It is never used on a patient, the demo scenarios are fictional, and the 911 call is simulated.

## Live demo

**https://clara.living** (hosted on Render's free plan: the first visit after 15 idle minutes takes about a minute to wake it, and demo data resets on restart)

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
| `packages/agent` | Current one-turn voice brain: Cartesia speech-to-text → Claude (Haiku 5.5, Opus 5.5 backup) picks one allowed action → Cartesia voice. Honesty guard in code. The persistent multiagent runtime is proposed in [conversation-runtime](docs/conversation-runtime.md). |
| `packages/network` | Incidents, volunteer matching, alerts (sent → shown → coming → arrived), escalation, the EMS scene report, box status, supply ledger |
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

## Credits

Parts of this repo are adapted from our Cal Hacks 13.0 project **Sophi** ([github.com/mzhao1599/sophi](https://github.com/mzhao1599/sophi)), with the HackPrinceton organizers' permission: Pi audio capture and playback, the speech queue, the serial protocol and firmware patterns, the screen server, the simulator, the Pi install and self-test scripts, the Cartesia clients, the Claude call wrapper and main/backup model hedge, and the help-request lifecycle behind the response network. Every adapted file says so at the top. Everything else was written during HackPrinceton.

Design ideas (not code) from Standard Response (Cal Hacks 13.0): an honesty rule enforced in code, a graded voice exam, and an escalation ladder.

First-aid content follows Stop the Bleed and Red Cross guidance and is marked draft until a teammate checks every step against the sources.

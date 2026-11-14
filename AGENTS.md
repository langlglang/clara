# Working in Clara

Clara is a HackPrinceton Fall 2026 build. Start with [docs/feature-list.md](docs/feature-list.md); it is the source of truth when older docs disagree. Clara is a proof of concept and is never used on a patient; demo scenarios are fictional and the 911 call is simulated.

## Layout

```text
packages/contracts/  shared types and zod schemas (events, scenarios, voice turns, network)
apps/web/            Next.js: box API, companion app, dashboard, maintainer backend, kit map, EMS report
box/                 Pi service: audio, voice loop client, scenario engine, screen server, serial to ESP32, simulator
firmware/            ESP32 (PlatformIO): lid switch, compartment LEDs, pulse sensor
content/             scenarios, step audio and pictures
docs/                design docs
```

## Habits

- TypeScript, Node 24, npm workspaces. Tests with vitest (`npm test` at the root); `npm run typecheck`.
- Code adapted from Sophi (github.com/mzhao1599/sophi) says so in a comment at the top of the file.
- The model never invents a measurement, a diagnosis, or a promise that help is coming. Names and arrival times come from templates after a real accept. Code enforces this, not only the prompt.
- Mock SOS stays reachable without the network, the model, or the camera. Never imply a real emergency call happened.
- API keys live only in the server's environment, never in the repo or on the box.
- Every device and cloud call has a deadline; a failure ends in a fixed line, and the touch flow keeps working.
- Keep the event list in `packages/contracts` the single shared language between box, server and apps.

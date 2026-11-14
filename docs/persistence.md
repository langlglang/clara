# Persistence: snapshots to Postgres

The server keeps its state in memory in one Next.js process (`apps/web/lib/server.ts`) and its APIs stay synchronous. With `DATABASE_URL` set, `apps/web/lib/persist.ts` saves the whole state as one JSON snapshot in Postgres and loads it at boot, so a Render restart, a redeploy or a free-plan spin-down resumes where it stopped. Without `DATABASE_URL` (local dev, tests) nothing changes: in memory, demo seed at start.

## What is saved

One row, `clara_snapshot` id `main` (`id text primary key, data jsonb, saved_at timestamptz`; the app creates the table). `data` is `{ version: 1, saved_at, generation, ... }` with:

- the network store: boxes (with manifest, restock and alert flags), volunteers, events with their idempotency ids and sequence numbers, incidents with alerts and report tokens (`packages/network/src/store.ts` `exportState` / `importState`). Old heartbeats are left out (the newest 5 per box are kept; battery and last seen live on the box record).
- rides with offers, winner and trip step (`lib/rides.ts`). Rides start no timers; `tick()` expires offers by their saved `expires_at`.
- vehicles per volunteer, messages to boxes, recent maintainer alerts.
- push subscriptions per volunteer and, when no `VAPID_*` env keys are set, the generated VAPID pair (otherwise restored subscriptions would be useless). If the public key changed since the save, the subscriptions are dropped.
- call bookkeeping: which alerts and offers were already decided, the hourly-cap history, the call log (`lib/calls.ts`), so nobody is called twice after a restart.
- the coordinator per incident: log (plan, actions, notes, flags, runs, memory, extra-alert counter), kit requests, ride proposals and requests, the last time-to-care estimate, the deep agent's carried filesystem and todos, run counters (`packages/coordinator/src/coordinator.ts`). A run cut off by the restart is marked "Interrupted by a server restart" and the next check plans again.
- any other book that exposes `exportState` / `importState`, under `extra` (for example the text-alert book once it does).

Not saved: the simulated-box list (it comes from `CLARA_SIMULATED_BOXES` at each start), live SSE connections (clients reconnect), and in-flight pushes or calls.

## Load and save

- **Boot:** every API route and both SSE streams get the runtime through `ensureRuntime()`. With a database, the first request waits for the load (3 tries, 5 s statement timeout each). The demo data is seeded only when there is no snapshot.
- **Unreadable snapshot** (unknown version, invalid data): logged loudly with `!!!`, a copy is kept as row `rejected-<time>`, and the server starts fresh with the demo seed. It never crashes on bad data.
- **Database unreachable at boot:** the server runs in memory and does **not** save, so it can't overwrite the good saved copy with a fresh seed. Restart once the database is back.
- **Saving:** every 2 s the state is serialized and written only if it changed (so at most one write per 2 s, within about 2 s of a change). A failed save is logged and retried with backoff; requests are never blocked. One small pool (max 3 connections).
- **Shutdown:** on SIGTERM/SIGINT a final save (up to 5 s), then exit. `render.yaml` sets `NEXT_MANUAL_SIG_HANDLE=true` so Next leaves the signal to the app.

## Two instances during a deploy

Render starts the new instance before stopping the old one. Each snapshot carries `generation`, the writer's start time in ms. The save is one conditional upsert that lands only when the stored generation is not newer than the writer's. The new instance loads the snapshot, then claims its generation with an immediate save; from then on the old instance's saves (its final SIGTERM save included) are refused, and it stops saving and says so in `/api/state`.

Remaining window: changes the old instance accepts after the new one loaded its snapshot (and changes from the last ~2 s before that load which hadn't been saved yet) are lost. That is the few seconds while Render switches traffic over. Generations are wall-clock times on different machines, so large clock skew between instances would also matter (not expected on Render).

## Status

`/api/state` (the health check) includes `persistence: { enabled, saving, last_saved_at, last_error, restored_from, generation }`. The maintainer console (`/maintainer`, Storage) shows "Saved · 3 s ago", "Not saving (no database)", or the error.

## Render

`render.yaml` adds a free Postgres `clara-db` in the web service's region (virginia) and wires `DATABASE_URL` from its internal connection string (no IP allow list: private network only). Render's free Postgres expires after 30 days; after that create a new one (or upgrade) and the app starts fresh.

## Tests

`apps/web/test/persistence.test.ts`: full round trip (a volunteer's "arrived" on a restored alert id succeeds), the generation guard, bad snapshots, and `persist.ts` against a fake pg client. No real database is needed.

# Response coordinator (deepagents)

Feature 28 (stretch): a LangChain **deepagents** agent that plans and coordinates the *human* response to an emergency. It works for the dispatcher, beside the network's own escalation ladder; it never replaces the honesty rules, the touch flow, or the mock SOS. Code: `packages/coordinator`; web wiring: `apps/web/lib/server.ts`, `apps/web/components/console/CoordinatorPanel.tsx`.

## What it does

For each open incident, on every trigger, one run:

1. **Plans** with `write_todos` (langchain's todo middleware, added to the deep agent). The plan, with statuses, is shown live on the dispatch console.
2. **Reads** the situation through read tools: `get_incident`, `list_candidates`, `get_nearby_kits`, `get_rides`, `get_site_overview`, `estimate_time_to_care`.
3. **Delegates** through deepagents' built-in `task` tool to three subagents, each with read-only tools:
   - `responder-scout`: candidates' skills against the need, distance and ETA, languages, who declined or hasn't answered; recommends who else to alert.
   - `logistics`: the box's stock and nearby kits, whether a second kit or a ride to hospital is needed, and which driver.
   - `time-to-care`: calls `estimate_time_to_care` and recommends whether to request a ride, in one line with the numbers.
   (deepagents' default `general-purpose` subagent is replaced by a read-only one, so every action stays with the main coordinator.)
4. **Acts** within the limits below.
5. **Notes**: one short dispatch note per run, needs-a-human flags when a person must decide, and working notes in `/notes.md` in its **virtual filesystem** (deepagents' state backend). The filesystem and todos carry over between runs of the same incident, so each run builds on the last.

The console's COORDINATOR panel shows a TIME TO CARE block (AMBULANCE scene / hospital, DRIVER name / pickup / hospital, DEADLINE marked "demo value", the verdict, and "Ride requested by coordinator: <reason>" when it acted), and a `DEEP AGENT` or `RULES` badge, run count and timing, the plan with check marks, actions with reasons (for example "Alerted Grace — Amina declined"), subagent answers, notes and flags. `GET /api/incidents/<id>/coordinator` returns the full log; changes also go out on `/api/stream` as `{ kind: "coordinator", incident_id, log }`.

## Time to care (`packages/coordinator/src/care.ts`)

`estimate_time_to_care` is computed by code (a pure function with unit tests); the model only reads it. For the incident:

- minutes since the SOS (`opened_at`) and since the tourniquet `timer.started`, if any;
- **ambulance** (the 911 call is simulated): reaches the scene `CLARA_AMBULANCE_ETA_MIN` (a demo setting) after the SOS, so minus the time elapsed; + `AMBULANCE_ON_SCENE_MIN` (15, demo) + the drive from the box to the nearest of the three fictional hospitals (`apps/web/lib/rides.ts`);
- **driver**: the best free suitable driver (`drivers_by_distance`: car or van, enough seats, lying-down / wheelchair when the scenario's `care` block needs it): pickup + `DRIVER_LOAD_MIN` (5, demo) + the same drive;
- **deadline**: the scenario's optional `care.reach_hospital_within_min` (`severe-bleeding.json`: 60), else need-based demo defaults (bleeding 60, breathing 30, general 120). Fictional demo values, not medical guidance.

Verdict: `unknown` (no ambulance setting or no hospital) → `ambulance_in_time` (ambulance at hospital within the time left) → `no_driver` → `ambulance_late_driver_faster` (driver faster and in time) → `both_late`. `qualifies_for_request` is true for the last two when the driver is at least 10 min faster than the ambulance. On Render (`CLARA_AMBULANCE_ETA_MIN=35`) a bleed at the clinic box is about 35 + 15 + 13 = 63 min by ambulance against about 3 + 5 + 13 by a nearby driver: ambulance late, driver faster.

## Safety limits (enforced in code, `packages/coordinator/src/tools.ts`)

| Tool | Limit |
| --- | --- |
| `alert_volunteers(ids, reason)` | Only ids the network currently lists as candidates (available, matching skill, in range, not busy, not alerted); at most 3 per call and 6 extra per incident; a reason is required. Any bad id refuses the whole call. Sends the standard alert (`sent`), nothing else. New network operation: `network.alertVolunteers`. |
| `request_kit(from_box_id, reason)` | One other box within 1.5 km that isn't offline, once per box per incident. Sends the existing `nearby.emergency` push ("bring this kit"), cleared on close. New network operation: `network.requestKit`. |
| `propose_ride(driver_id, reason)` | Opens the ride plan if needed and records a proposal for the dispatcher. It never approves and never offers a ride to a driver; the ride adapter it gets has no approve. At most 2 per incident; motorbikes and drivers outside the plan are refused. |
| `request_ride(reason)` | Opens the ride (or reuses a plan with no open offers) **and sends offers at once** to the 2 best suitable drivers through the usual flow (push, call fallback, first accept wins; ride-book operation `requestNow`). Only when this run's latest `estimate_time_to_care` says `qualifies_for_request` (verdict `ambulance_late_driver_faster` or `both_late` with a driver at least 10 min faster), the incident is open, no ride is offered or accepted, and only once per incident (a ride the dispatcher cancelled is not re-requested). The dispatcher can cancel or reassign. `propose_ride` stays for every other case. |
| `post_dispatch_note(text)` | Dispatch console only, at most 400 characters, 20 per incident. |
| `flag_for_dispatcher(reason)` | A visible "needs a human" flag; deduplicated, 5 per incident. |

There is no tool that talks to the bystander, the box voice, or volunteers beyond the existing alert. The coordinator cannot close incidents, mark anyone coming or arrived, approve a dispatcher's ride plan, or contact emergency services, and never presents the simulated ambulance ETA as a real one. After the run deadline every tool refuses. Tool results are data, and the prompts say so.

## Runtime rules (`packages/coordinator/src/coordinator.ts`)

- Triggers: incident opened, `sos.opened` (again) and a tourniquet `timer.started` on the incident's box, an alert declined or expired, escalation level change, and every 45 s while open.
- Debounce 3 s; one run at a time per incident (triggers during a run queue one follow-up run); at most 10 runs per incident; a 60 s deadline per run with an `AbortSignal` passed to the agent.
- Failures and timeouts are logged in the run entry and the server log, never thrown into the network. Closed incidents stop.

## Modes

| `CLARA_COORDINATOR` | Behaviour |
| --- | --- |
| `on` (default) | Deep agent when `ANTHROPIC_API_KEY` is set; **off** without it. |
| `rules` | Deterministic planner (`src/rules.ts`) through the same tool layer, no LLM, labelled `RULES`. Alerts a medical candidate after a decline or silence, asks the nearest box for its kit after escalation, requests a ride when `estimate_time_to_care` qualifies (otherwise proposes the suggested driver once a tourniquet is on), flags when nobody is left. |
| `off` | Disabled (no-op). |

`CLARA_COORDINATOR_MODEL` overrides the model (default `claude-opus-5-5`); `CLARA_COORDINATOR_EFFORT` is `low` (default) or `medium`.

## Model setup

`createDeepAgent({ model, systemPrompt, tools, subagents, middleware: [todoListMiddleware(), logMiddleware] })` with `ChatAnthropic({ model: "claude-opus-5-5", maxTokens: 4096, maxRetries: 1, outputConfig: { effort: "low" } })`. No temperature, top_p or top_k (they return 400 on current Claude models; @langchain/anthropic also omits them for this model family), no `thinking` field (adaptive by default), no forced `tool_choice`, no assistant prefill. A test drives the whole agent against a fake Anthropic client and checks the request body for exactly this. deepagents adds Anthropic prompt caching itself. LangChain / deepagents load lazily on the server only in deep-agent mode and are kept out of the Next bundle (`serverExternalPackages`).

## Run it

```bash
# Without a key: the rules planner
CLARA_COORDINATOR=rules npm run web
# With a key in apps/web/.env.local: the deep agent
npm run web
curl -X POST "http://localhost:3000/api/demo/sos?box=box-clinic&need=bleeding"
curl http://localhost:3000/api/incidents/<incident_id>/coordinator
# The whole scene, including time to care: with CLARA_AMBULANCE_ETA_MIN=35 the coordinator requests a ride after
# the SOS and the simulator plays the first offered driver (I CAN DRIVE → patient in car → at hospital).
CLARA_COORDINATOR=rules CLARA_AMBULANCE_ETA_MIN=35 npm run web
npx tsx scripts/simulate-scene.ts --server http://localhost:3000 --box box-clinic --cast --minutes 3
```

Tracing: set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` (optionally `LANGSMITH_PROJECT`); LangChain picks them up from the environment and each run is named `clara-coordinator`, tagged with the incident id.

## Tests

`packages/coordinator/test`: time to care (`care.test.ts`), `request_ride` limits, the rules planner requesting a ride, and the SOS / tourniquet triggers (`request-ride.test.ts`), tool limits, triggering (debounce, one at a time, run limit, deadline abort, failing runner, disabled without a key), the rules planner, and the deep agent driven by LangChain's `fakeModel()` (plan, a `responder-scout` delegation, a refused then accepted alert, a note, a file in the virtual filesystem). `packages/network/test/coordinator-ops.test.ts` covers the two new network operations. `apps/web/test/coordinator.test.ts` covers the route, the incident detail, the stream and a rules-mode ride request with the 35 min demo ambulance; `apps/web/test/rides.test.ts` covers `preview` and `requestNow`.

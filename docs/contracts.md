# Interface and message contracts — proposal v0.7

**Interaction update:** the implemented screen exposes simulated SOS and speaker mute as touch actions; legacy step-navigation actions remain in the internal `ScreenPressSchema` for compatibility but have no visible controls. Lid open does not produce a voice turn. The proposed generic presentation contract is specified below and in [conversation runtime](conversation-runtime.md).

## Pi → kiosk screen — implemented `screen-view/1.3`

The Pi sends whole `ScreenView` snapshots over a local, token-protected Server-Sent Events stream. `schema_version: "screen-view/1.3"` adds `report_link`, `scenario_id`, `scenarios`, `coach`, and `pulse_prompt` to the `1.2` surface; `1.2` added `speech_muted`; `revision` is a monotonically increasing view update counter, not a schema version. The page rejects unknown schema majors. `lid_open` is the physical lid state, independent of `phase`: while closed and idle the page is visually black; touching it reveals SOS and Mute for 15 seconds without opening the microphone. A simulated SOS countdown or call remains visible even with the lid closed. `voice_state` is `off`, `starting`, `ready`, `listening`, `processing`, `speaking`, or `unavailable`; ready means the mic is open, listening means voice activity was detected, and processing means a final utterance was sent. `speech_muted` silences Clara's speech and cues, while the microphone, visual replies, and mock SOS remain active. The page sends `mute` and `unmute` through the same token-protected press endpoint as SOS. Existing `step` remains for older consumers, but the current page renders `presentation` when present. A null presentation means the idle view. Old consumers can ignore new fields and continue to use `step`; a new consumer must handle null and all enumerated kinds.

```json
{
  "schema_version": "screen-view/1.3", "revision": 7, "phase": "guiding",
  "lid_open": true, "voice_state": "listening", "speech_muted": false, "box_name": "Clara", "online": true,
  "presentation": {
    "kind": "item", "title": "sterile gauze packs", "body": "In the bottom compartment.",
    "image_url": "/content/kits/layout-3slot-v1-bottom.svg", "item": {"sku":"GAUZE","name":"sterile gauze packs","slot":"bottom","lit":true,"missing":false},
    "source_label": "Kit inventory"
  },
  "step": null, "report_link": null, "scenario_id": "severe_bleeding",
  "scenarios": [{"scenario_id":"severe_bleeding","title":"Severe bleeding"},{"scenario_id":"not_breathing","title":"Not breathing"}],
  "coach": null, "pulse_prompt": false
}
```

Current producers include spoken answer/question captions, kit inventory lookup, versioned scenario guidance, allowlisted illustrations, and a hardware-backed pulse reading. A consented camera observation can also appear as a source-labeled result card. The Pi now produces a fixed-template, local on-box handoff card; a consented, remotely shared handoff remains proposed. A reading producer must bind a fresh connected-hardware result, units, time and quality before showing a number. Item producers use the current `clara-3slot-v1` manifest, never model-generated slot text. That manifest's 22 named supplies map to the owner's visually verified channel positions: `top-left → 0/GPIO18`, `top-right → 1/GPIO19`, `bottom → 2/GPIO23`; its `3slot-v1` screen SVGs show the same layout. Presence is confirmed, but exact package counts, expiry and lot still need a restock check. The `presentation` field is a display snapshot, not permission for the model to choose arbitrary medical instructions or assets. The Pi producer, kiosk consumer, example above and compatibility tests change together; future meaning changes require a new major.

### CPR, local handoff, and report link additions — implemented in code

`ScreenView.coach` is either null or `{kind:"cpr",bpm,started_at}`. The kiosk derives its beat count from elapsed time; this is a pacing display, **not** a measured compression count. The draft `not_breathing/draft-1` scenario declares `step.coach:{kind:"cpr",bpm:110}`. Its producer is the Pi scenario engine/rhythm coach; consumers are the screen and the ESP32 rhythm command. The coach plays generated metronome WAV segments, pauses ticks for speech, repeats a fixed prompt, and clears on stop, scenario change, or session close. `pulse_prompt` only asks the bystander to check responsiveness and breathing after a missing hardware pulse result while the clip appears in use. Only the bystander's voice or touch answer can start the CPR scenario and mock SOS; the sensor does not decide. The screen accepts `pick_scenario {scenario_id}`, `pulse_not_breathing`, `pulse_breathing`, `stop_coach`, and `read_summary` presses. The Pi validates the scenario ID against loaded bundles and ignores a pulse answer when no prompt is pending. The on-box `handoff` presentation is built locally from this session's events with fixed MIST-style templates; its speech uses the existing queue, works offline, and does not assert that a displayed step was performed. These paths have focused code tests but no physical end-to-end verification.

The cloud `incident.opened` box push now includes `incident_id`, absolute `report_url`, and six-character `report_code` (producer: `packages/network`; consumers: `@clara/contracts` and Pi session). The Pi uses the code to show a short text link such as `clara.living/r/AB12CD` during mock SOS; it shows no QR code. The web `/r/[code]` route maps a unique code to the secret-token report and returns 404 for unknown or ambiguous codes. It never exposes the token in the short code itself. The link arrives only after the server opens an incident, so it can be null while offline. A new consumer must handle null `report_link` and `coach`, false `pulse_prompt`, unknown optional same-major fields, and rejected unknown schema majors; focused tests cover the new screen state and box push. The report link is a demo handoff path, not proof of a real emergency contact.

```json
{"type":"incident.opened","incident_id":"box-demo-incident","report_url":"https://clara.living/report/<opaque-token>","report_code":"AB12CD"}
```

The strict box-push parser requires the new fields for `incident.opened`, so deploy the updated server and Pi consumer together; an older strict consumer will reject this push. Tests cover the short-code route, including unknown and ambiguous codes, and the Pi screen/coach/handoff paths. Physical end-to-end behavior remains unverified.

## Mock emergency fact bridge — implemented `events/0.2`

This is fact collection for a **simulated** call, not a 911 caller. After the local mock countdown, the Pi emits `sos.opened`, then `emergency.context` with `task_id` equal to that SOS event ID. `location` is `{kind:"configured_address",address}` or `{kind:"unavailable"}`. The live GPS fix stays on the Pi because this demo has no per-session cloud location-sharing consent. The event batch version is `events/0.2`; `0.1` is rejected rather than silently reinterpreted. Producer: `box/src/session`; consumers: `@clara/contracts` schema, the web event ingest, and `apps/web/lib/emergency.ts`. The backend worker starts once per incident, waits up to 2 s for context, then may push `emergency.status` (`collecting_facts`, `facts_ready`, `cancelled`) and one `emergency.question` at a time. Fixed question IDs are `situation`, `people_count`, and `location`. It asks location only when no configured address was provided. This fact worker itself never dials, messages 911, or speaks; a separate optional demo-phone adapter is described below.

```json
{"schema_version":"events/0.2","events":[{"event_id":"00000000-0000-4000-8000-000000000201","box_id":"box-demo","session_id":"00000000-0000-4000-8000-000000000202","occurred_at":"2026-11-13T20:00:00Z","type":"emergency.context","task_id":"00000000-0000-4000-8000-000000000200","location":{"kind":"configured_address","address":"1455 California Ave"}}]}
```

The server pushes `emergency.question {incident_id,task_id,session_id,question_id,prompt,speech?}` to the same box. The Pi accepts it only for the current mock SOS task and session. It treats push text as untrusted, choosing the question text from its own fixed `question_id` map; a matching canonical prompt may include Cartesia WAV, with local speech fallback. The question expires after 120 s, clears on lid close, and uses Clara's one screen and speech queue. `voice-turn/0.3` adds optional `state.pending_emergency_question {task_id,question_id,prompt}` and `answer_emergency_question {task_id,question_id}`. The model returns **IDs only**, never answer text. The Pi emits `emergency.answer {task_id,question_id,answer,source_event_id}` only when this turn's final transcript exactly matches its earlier `report.heard` event. The server verifies the referenced report is earlier, from the same session, and has that exact text. It remains a **user report**, not a verified observation. The model policy leaves unrelated speech in the ordinary conversation; semantic answer matching still needs scenario tests. Duplicate, late, wrong-task, and wrong-session messages are ignored. Closing the incident cancels fact collection; an unanswered question leaves a gap rather than an invented answer.

```json
{"schema_version":"events/0.2","events":[{"event_id":"00000000-0000-4000-8000-000000000203","box_id":"box-demo","session_id":"00000000-0000-4000-8000-000000000202","occurred_at":"2026-11-13T20:00:12Z","type":"emergency.answer","task_id":"00000000-0000-4000-8000-000000000200","question_id":"people_count","answer":"Two people","source_event_id":"00000000-0000-4000-8000-000000000199"}]}
```

`BoxPush` is a separate server-to-Pi stream. Its new `emergency.question` payload has `incident_id`, `task_id`, `session_id`, `question_id`, and fixed `prompt`; `emergency.status` has `incident_id`, `task_id`, `session_id`, and `state`. Producers and consumers share `packages/contracts/src/network.ts`. The new fields and actions require compatibility tests for old-version rejection, missing/late/wrong-session context and answers, report provenance, duplicate SOS, cancellation, and ordinary speech while a question is pending. This bridge is scoped to a mock incident. The proposed real caller contract later in this document remains separate and unimplemented.

### Optional team-phone briefing — implemented in code

`apps/web/lib/demo911.ts` subscribes to `sos.opened` independently of the fact worker. With Twilio credentials and a valid team-owned `CLARA_DEMO_911_NUMBER`, it waits about 4 s and attempts one Twilio call per incident. It rejects emergency short codes and non-E.164 targets. Missing configuration produces `not_configured` rather than a call. The inline TwiML identifies the call as simulated and reads a one-time briefing assembled from incident events known then: configured address labeled as such, bystander reports, guidance-timer starts labeled as unconfirmed treatment, and responder status. Later `emergency.answer` events are not added to that call. The in-memory result is `placed`, `failed`, or `not_configured`; `placed` means Twilio accepted the API request, **not** that the demo phone answered. No 911 number, emergency service, or real dispatcher is contacted. This adapter adds no Pi wire message or event schema; phone delivery has not been verified outside tests.

The separate `/call/{incident_id}` page plays an on-demand simulated script from the same source-labeled briefing lines; it does not place a call. Its briefing and audio APIs require the configured Admin credential because they include bystander reports and location. The page asks for that credential and keeps it only in the browser session, never in the URL.

The broad `2.4` envelope below is still proposed. The Pi ↔ ESP32 link has an implemented, smaller [serial `1.1` schema](../packages/contracts/src/serial.ts); its wire messages and hardware status are described in [the firmware guide](../firmware/README.md). The Pi's implemented local `LocationProvider.current()` returns a fresh `GpsFix { latitude, longitude, observedAt, accuracyM }` or null; invalid/stale NMEA is not a fix. It accepts a checksummed 9600-baud RMC sentence only when status and fix time are valid, with a 15 s receipt and 30 s fix-time freshness limit. Mock SOS coaching uses that result or the configured address `1455 California Ave`, explicitly labeled as configured. This local location does not populate the proposed outbound `location.observation` message or send a volunteer alert. The installed receiver emitted a valid RMC/GGA fix and the service connected to its port; mock SOS display with that live fix remains unverified. JSON examples in this document are illustrative. All clocks use UTC RFC 3339 plus a monotonic `uptime_ms` where ordering matters. IDs are opaque UUIDs. `null` is never a fake reading.

## Implemented Pi ↔ ESP32 serial `1.1`

The ESP32 and Pi use 115200-baud newline JSON, maximum 1 KiB per line. `hello` requires `proto:"1.1"`, a per-reset `boot` identifier, firmware version and installed LED count; the Pi rejects an older hello. The current board has three installed LED channels (GPIO18, GPIO19, GPIO23), a lid switch on GPIO33, and MAX30102 I²C on GPIO21/22. The Pi's `sensor.read` command has an integer `id`. The ESP32 ACKs it, then returns `sensor.raw` with the same `id`, an advanced `sample_seq`, a reconstructed monotonic sample time after the request, red/IR counts and `quality:"valid"`; after one second without a new sample it returns null counts with `quality:"unavailable"`. A missing sensor or closed lid is NACKed. The Pi returns null on unavailable, timeout, malformed values or disconnect. It never substitutes a fixture or generated reading. Raw `valid` describes transport freshness, not medical accuracy.

`pulse.start` and `pulse.stop` are separate commands. The ESP32's demo-only signal processor reports a numeric BPM only after contact, continuous 25-record/s input, non-saturated signal, enough prominent peaks and consistent recent intervals; otherwise the `pulse` event has `bpm:null`. It calculates no SpO₂. The Pi keeps raw sensor data out of ordinary logs. The current Pi checks item IDs against its local manifest before issuing the simple LED command; the larger `2.4` request envelope and clinical validation are not implemented. Change the serial protocol literal, producer, Zod consumer, examples and compatibility tests together.

## Versioning and transport

- Envelope `schema_version: "2.4"` uses semantic major/minor. The 2.0 pre-implementation draft removed an unsupported required battery field from lid events and used the selected raw optical sensor; 2.1 defines optional fields for a future ESP32-derived pulse result; 2.2 adds optional compartment-light mapping and commands; 2.3 adds the optional handoff card; 2.4 adds optional box-network events (`box.status`, `network.alert`, `network.alert.ack`, `network.alert.clear`) and anti-theft events (`mount.removed`/`mount.restored`, `alarm.set.request`, `alarm.status`, `security.flag`) and running supply-ledger events (`supply.expected_use`, `supply.usage_proposed`, `supply.usage_confirmed`, `supply.usage_unconfirmed`, `supply.restocked`). No existing field changes meaning. Add optional fields or new event types in a minor version; change meaning, required fields, enum semantics or units in a major version. Producers send their supported major/minor in `hello`; consumers reject unknown major and ignore unknown optional fields in same major. Older consumers ignore unsupported optional events and leave unsupported effects off.
- ESP32-WROOM-32 board ↔ Pi: USB cable to the board's USB-to-UART bridge, exposing a Linux serial device. Demo framing is newline-delimited JSON, maximum 1 KiB per message, 115200 baud, with event ID, per-boot sequence and `boot_id`; ACK/retry for state changes. Discover by `/dev/serial/by-id/` where available, not a hard-coded `ttyUSB0`. The link may carry a current sensor result for the active session; do not log that payload. If later moving to a noisy or longer link, add a length/CRC frame in a new contract version.
- Pi ↔ cloud: TLS 1.3 WebSocket for streaming events and HTTPS for signed bundles/manifest. Device identity uses per-device credentials with rotation; no secret in firmware logs.
- Screen ↔ agent: ordered session event stream. Companion ↔ directory: HTTPS; location records include verification and revision. No direct companion-to-box control in v0.1.
- Every command with side effects has `request_id` idempotency and a deadline. ACK means received, not completed. Completion has its own result event.

## Common envelope

```json
{
  "schema_version": "2.4", "event_id": "uuid", "session_id": "uuid",
  "source": "screen", "type": "utterance.final", "seq": 42,
  "occurred_at": "2026-11-02T20:00:00Z", "uptime_ms": 30012,
  "trace_id": "uuid", "payload": {}
}
```

Required: version, event ID, source, type, sequence, occurrence time, payload. `session_id` is optional only for boot/heartbeat, `box.status`, network alerts, mount events and `security.flag`. Reject oversize payloads, malformed UTF-8, duplicate event IDs, and timestamp/sequence conflicts; log a minimal error without media. Authenticate source before trusting identifiers.

## Event catalog

| Producer → consumer | Type | Required payload | Meaning |
| --- | --- | --- | --- |
| MCU → screen | `lid.opened` / `lid.closed` | `boot_id`, `switch_state` | Debounced physical state; not proof that screen is ready. No battery voltage is inferred. |
| MCU → screen | `power.health` | `fault_codes[]`; `battery_mv?`, `external_power?` only with installed measurement hardware | Optional telemetry. Omit unknown readings; do not emit from a controller with no voltage-sense path. |
| Screen → cloud | `session.hello` | `box_id`, `capabilities[]`, `protocol_hash`, `manifest_rev`, `consent_grants[]` | Start/restore authenticated session |
| Screen → cloud | `utterance.partial` / `utterance.final` | `turn_id`, `text`, `language`, `confidence` | Partial cannot advance a demo step |
| Screen → cloud | `user.action` | `action` (`next`, `back`, `repeat`, `stop`, `sos`), `step_package_id?` | Historical 2.4 proposal; the current kiosk exposes only mock SOS and overlay controls. Do not implement step-navigation actions from this draft. |
| Screen → cloud | `media.capture` | `consent_id`, `frame_id`, `captured_at`, `purpose`, `sha256` | Single frame metadata; media goes via scoped upload |
| Screen → cloud | `location.observation` | `consent_id`, `latitude`, `longitude`, `accuracy_m`, `observed_at`, `source_model` | Proposed outbound message only. The local USB GNSS fix used for mock SOS coaching is not sent. A future producer must require a fresh fix and separate consent; never replace a configured site address with an inferred one. |
| Screen → MCU | `sensor.read.request` | `request_id`, `device_id`, `measurement_type`, `deadline_ms` | Starts a fresh wired sensor observation; ACK is not a result |
| MCU → screen | `sensor.reading` | `request_id`, `device_id`, `model`, `sample_seq`, `sampled_uptime_ms`, `measurements[]`, `quality` | New I²C result; Pi validates and adds UTC receive time |
| Screen → MCU | `light.set.request` | `request_id`, `step_package_id`, `kit_revision`, `manifest_rev`, `slot_id`, `channel`, `lease_ms`, `deadline_ms` | Set exactly one verified compartment output; Pi resolves slot to channel before sending |
| Screen → MCU | `light.clear.request` | `request_id`, `reason`, `deadline_ms` | Turn all compartment outputs off |
| MCU → screen | `light.status` | `request_id`, `state`, `channel?`, `lease_expires_uptime_ms?` | Completion or rejection; `on` means output asserted, not verified light emission |
| Cloud → screen | `step.present` | `step_package` below | Proposed legacy scenario package presentation; general visual cards are specified by `presentation/1.0` below. |
| Cloud → screen | `agent.status` | `state`, `turn_id`, `message?` | Working/offline/failed; never implies emergency call success |
| Screen → cloud | `turn.cancel` | `turn_id`, `reason` | Late tool/agent results must be ignored |
| Screen/app → cloud | `emergency.status` | `state`, `source`, `observed_at` | Demo only: `mock_opened` or `mock_failed`; no real call state |
| Cloud/local builder → screen | `handoff.present` | `handoff_card` below | Show a source-labeled fictional context card after local user action; never send it to a remote person in the demo |
| MCU → screen | `mount.removed` / `mount.restored` | `boot_id`, `switch_state` | Debounced bracket switch state (2.4). Not proof of theft; the Pi decides whether a session was active. |
| Screen → MCU | `alarm.set.request` | `request_id`, `pattern` (`open_chime`, `alert_chime`, `off`), `lease_ms`, `deadline_ms` | Drive the buzzer and light-flash pattern for a bounded lease (proposed maximum 10 s) (2.4). `off` always wins. |
| MCU → screen | `alarm.status` | `request_id`, `state` (`on`, `off`, `rejected`) | Output asserted, not proof of sound (2.4) |
| Screen → cloud | `box.status` | `box_id`, `site_id`, `state` (`ready`, `in_use`, `low_supplies`), `manifest_rev`, `supply_summary[]`, `sent_at` | Heartbeat every 30 s and on change (2.4). Supply summary comes from the verified manifest. No health data, media or transcript. The registry, not the box, marks a silent box `offline`. |
| Cloud → screen | `network.alert` | `incident_id`, `origin_box_id`, `site_id`, `origin_location`, `directions_id`, `need` (`bleeding_kit`, `general_kit`), `created_at`, `expires_at` | Sent to other boxes at the same site after the origin reports `mock_opened` (2.4). One per incident. Never contains a transcript, image, reading or handoff card. |
| Screen → cloud | `network.alert.ack` | `incident_id`, `box_id`, `action` (`bringing_kit`, `dismissed`), `acted_at` | A local tap at the receiving box (2.4). The origin shows it as unconfirmed; it is not proof that anyone is coming. |
| Cloud → screen | `network.alert.clear` | `incident_id`, `reason` (`origin_closed`, `origin_stop`, `staff_clear`, `expired`) | Receiving boxes remove the card and stop the alert pattern (2.4) |
| Screen → cloud | `security.flag` | `flag_id`, `box_id`, `kind` (`open_no_emergency`, `item_missing_no_emergency`, `mount_removed_no_session`, `return_overdue`), `opened_at?`, `duration_s?`, `snapshot_ref?`, `raised_at` | For the maintainer view only (2.4). `snapshot_ref` points to the local encrypted frame; the frame itself is fetched only by the maintainer role. Wording is "needs check," never "theft." |
| Screen (local) | `supply.expected_use` | `session_id`, `step_id`, `sku`, `qty`, `manifest_rev` | Logged when a scenario step that uses an item is shown (2.4). A hint for the end-of-session screen, not a count change. |
| Screen (local) | `supply.usage_proposed` | `usage_id`, `session_id`, `manifest_rev`, `items[]` (`sku`, `qty`), `source` (`agent`, `expected_use`, `manual`) | Proposed list awaiting a confirm tap (2.4). An `agent` proposal is a user report mapped by the model; unknown SKUs or quantities above stock are rejected before display. |
| Screen → cloud | `supply.usage_confirmed` | `usage_id`, `box_id`, `manifest_rev`, `items[]`, `confirmed_at` | The only event that lowers stock (2.4). Written after a local confirm tap. Synced to the hub through the outbox. |
| Screen → cloud | `supply.usage_unconfirmed` | `usage_id`, `box_id`, `manifest_rev`, `slot_ids[]`, `recorded_at` | No confirmation before session end (2.4). Affected slots become unverified; no count change. |
| Screen → cloud | `supply.restocked` | `box_id`, `manifest_rev`, `items[]` (`sku`, `slot_id`, `qty`), `verified_by`, `verified_at` | A teammate's restock check (2.4). Resets counts and clears unverified slots. |

## Core objects

```json
{
  "step_package_id": "uuid", "protocol_id": "adult_severe_bleeding",
  "protocol_version": "demo-v1", "bundle_hash": "sha256:...",
  "step_id": "demo-step-id", "variant_id": "plain_en_US",
  "text": "Versioned demo text from bundle",
  "speech_script": "Versioned demo speech from bundle",
  "visual": {"asset_id": "demo-asset-id", "sha256": "sha256:...", "alt_text": "Asset description"},
  "item": {"sku": "DRESSING-01", "manifest_rev": 3, "slot_id": "B2", "verified": true},
  "requires_ack": true, "mock_sos_banner": true
}
```

The renderer verifies bundle hash and step/asset linkage before display. `item` may be absent; if `verified` is false, do not say the item is present. Speech, text and visual share one package ID and step cursor.

The Pi may issue `light.set.request` only after the active package's `item` passes SKU, manifest, layout and slot-light-map checks. The command's `channel` is a physical output index, not model-generated text. The ESP32 accepts a channel only in its configured range and a short lease (proposed maximum 30 seconds), clears all other outputs first, and rejects a closed-lid, stale-sequence or expired-deadline command. Renew only while the same step remains active. The Pi sends `light.clear.request` on a step change, interruption, Stop or mock SOS; the ESP32 also clears on lid close, USB disconnect, reset or lease expiry. A failed/late status cannot make the screen claim a light is on.

Example `light.set.request` payload for a proposed six-slot tray: `{"request_id":"uuid","step_package_id":"uuid","kit_revision":3,"manifest_rev":3,"slot_id":"B2","channel":3,"lease_ms":15000,"deadline_ms":500}`. `light.status.state` is `on`, `off`, or `rejected`; `on` confirms only the asserted GPIO output. A repeated request ID returns the same result rather than extending the lease; a renewal has a new request ID.

Proposed `handoff_card` for a **fictional** on-box demo:

```json
{
  "handoff_card_id": "uuid", "session_id": "uuid",
  "created_at": "2026-11-03T20:00:03Z", "recipient_scope": "in_person",
  "site_id": "fictional-public-site", "mock_sos_state": "mock_opened",
  "facts": [{"source_type": "user_report", "source_event_id": "uuid",
             "observed_at": "2026-11-03T20:00:01Z",
             "text": "Volunteer reported a fictional bleeding scenario",
             "certainty": "reported_unconfirmed"}],
  "steps": [{"step_id": "demo-step-id", "state": "shown",
             "observed_at": "2026-11-03T20:00:02Z"}],
  "open_questions": ["Has the volunteer found the dressing?"],
  "consent_scope": "on_box"
}
```

Allowed fact sources are `user_report`, `camera_observation`, `sensor_reading`, and `local_action`; each needs an event ID and time. Camera/sensor entries require separate sharing consent and must preserve uncertainty, device and freshness. Step state is `shown` or `acknowledged`, never inferred as completed. The validator rejects a card with unsupported claims, unconsented observations, a mismatched session, or a claimed real SOS outcome. If the agent is unavailable, the Pi constructs a minimal card from local events. The on-box card expires with the session and stays behind a user-invoked Show handoff control.

```json
{
  "request_id": "uuid", "device_id": "opaque-id", "model": "MAX30102-breakout",
  "sample_seq": 81, "sampled_uptime_ms": 30012,
  "measurements": [{"type": "ppg_red_raw", "value": 40217, "unit": "count"},
                   {"type": "ppg_ir_raw", "value": 48701, "unit": "count"}],
  "received_at": "2026-11-02T20:00:02Z", "quality": "valid",
  "provenance": {"transport": "ESP32-I2C-USB-serial", "adapter_version": "1.0", "source": "sensor_raw"},
  "consent_id": "uuid"
}
```

These numbers are illustrative schema fixtures, never runtime results. The selected MAX30102 emits raw optical samples; `measurement_type: "ppg_raw"` requests new red/IR samples. The breakout does **not** emit heart rate or SpO₂ directly. A future ESP32-derived `heart_rate` result uses `measurements: [{"type":"heart_rate","value":80,"unit":"bpm"}]`, `provenance.source: "derived"`, `algorithm_version`, `window_start_uptime_ms`, and `window_end_uptime_ms`. These window bounds use the ESP32 monotonic clock and must enclose enough fresh samples; no numeric bpm is displayed until that algorithm is checked. At runtime, `sensor.read` must obtain **new values from the wired board**. The ESP32 records when it receives the request in its monotonic uptime clock and returns only later board updates with new `sample_seq`; the Pi stamps `received_at` in UTC. Do not present that receive time as a precise physiological measurement time. A direct Pi I²C adapter uses the same logical fields and its own monotonic clock. Allowed `quality`: `valid`, `suspect`, `invalid`, `unavailable`; `valid` means fresh and well formed, **not medically accurate**. Never coerce missing fields to zero or replace a failed read with a fixture or generated value. The demo displays only fresh, valid results and does not use values to choose treatment steps. The overall UI identifies Clara as a demo; no per-reading warning badge is required.

## Tool result and error contract

```json
{
  "request_id": "uuid", "turn_id": "uuid", "status": "error",
  "observed_at": "2026-11-02T20:00:03Z", "provenance": "inventory-service@1.0",
  "error": {"code": "MANIFEST_STALE", "retryable": false, "message": "Slot verification expired"}
}
```

Errors: `UNAUTHORIZED`, `CONSENT_REQUIRED`, `UNSUPPORTED_VERSION`, `TIMEOUT`, `DISCONNECTED`, `STALE_RESULT`, `INVALID_QUALITY`, `MANIFEST_STALE`, `PROTOCOL_UNAVAILABLE`, `INTERNAL`. User messages use safe mapped copy, not internal stack traces. A retry requires the same request ID for side effects or a new ID for a new observation; deadline and cancellation still apply.

## Inventory and directory records

```json
{
  "kit_model": "CL-DEMO-A", "kit_revision": 3, "box_id": "opaque-id",
  "manifest_rev": 3, "layout_asset_id": "CL-DEMO-A-r3-top",
  "verified_at": "2026-11-02T19:00:00Z", "verified_by": "authorized-restocker-id",
  "items": [{"sku": "DRESSING-01", "lot": "lot-ref", "expiry": "2028-01-01", "slot_id": "B2", "quantity": 2, "state": "present"}],
  "slot_lights": [{"slot_id": "B2", "channel": 3}]
}
```

Each physical box is sealed/labeled with model and revision; restocker scans each slot, records lot/expiry, signs a manifest, and photographs layout. Runtime checks box ID + manifest revision + layout asset hash. After use or broken seal, mark affected items `unknown` until reverified. Never silently substitute a supply or slot across revisions. Directory records contain `site_id`, verified address/floor/landmark, accessibility/availability status, last inspection, and optional GNSS location with `accuracy_m` and age; stale availability is displayed as such.

`slot_lights` is optional until LEDs are installed. Its channel numbers are local to the box and must be unique, within the ESP32's configured output count, and physically checked against each printed slot. The mapping is part of the versioned manifest and must change with any tray or wiring revision. If absent, mismatched, or unverified, the Pi sends no `light.set.request` and relies on the screen/printed labels.

## Box network and anti-theft rules (2.4)

`network.alert` is sent by deterministic Pi and backend code after `emergency.status: mock_opened`, never by the agent, a camera frame or a sensor value. It is idempotent by `incident_id`; a duplicate SOS tap keeps the same incident. Delivery and `network.alert.ack` are separate states, and the origin box never shows "sent" without a delivery record. A receiving box that already has an active session shows a banner instead of a full-screen card. Directions are referenced by `directions_id` from the verified site record; the agent may read them aloud but cannot generate a route. These box-to-box alerts are **not** responder alerts: they reach the team's own demo boxes, not people's phones, and do not use the later `responder-alert` contract.

The ESP32 starts every buzzer output off, clears the alarm on lease expiry, lid close, USB disconnect or reset, and treats `off` as higher priority than any pattern. The open snapshot is a local file on the Pi referenced by `snapshot_ref`; it never travels in a session event, `media.capture`, `network.alert` or `handoff_card`. A snapshot or buzzer failure never delays `lid.opened` handling.

## Voice turn API — implemented `voice-turn/0.8`

A request/response HTTP contract between the box and the server, separate from the event envelope. Producer: `box/` (cloud client). Consumer: `apps/web/` (`POST /api/boxes/{box_id}/turns`). Shared zod schemas live in `packages/contracts`; the box and server import the same file, and `packages/contracts` tests cover both shapes. Design: [voice](voice.md).

Request (JSON, at most 1.5 MB):

```json
{
  "schema_version": "voice-turn/0.8", "client_turn_id": "uuid", "session_id": "uuid",
  "language": "en",
  "input": { "type": "audio", "mime": "audio/wav", "data_base64": "…", "duration_ms": 2400 },
  "state": {
    "scenario_id": "severe_bleeding", "step_id": null,
    "allowed_steps": [{ "step_id": "start", "label": "Tell me what happened" }],
    "questions": [{ "question_id": "where", "text": "Where is the bleeding?" }],
    "manifest": [{ "sku": "GAUZE", "name": "sterile gauze packs", "on_hand": 1 }],
    "available_visuals": [{ "visual_id": "kit_overview", "label": "Clara kit layout" }],
    "guided_scenarios": [{ "scenario_id": "minor_cut", "label": "Superficial cut or scrape", "start_step_id": "get_bandage" }],
    "guided_active": false,
    "triage_available": true,
    "recent_turns": [{ "from": "person", "words": "…" }, { "from": "clara", "words": "…" }]
  }
}
```

`input` is either audio (16 kHz mono 16-bit WAV, at most 15 s) or `{ "type": "text", "text": "…" }` (at most 500 characters, for the Talk-by-typing fallback and tests). `language` is a BCP 47 code the server passes to speech-to-text and text-to-speech.

Response:

```json
{
  "schema_version": "voice-turn/0.8", "client_turn_id": "uuid",
  "heard": "my friend's leg is bleeding a lot",
  "reply": "Tell me what happened and what you need help with.",
  "action": { "name": "select_step", "step_id": "start" },
  "answered_by": "model",
  "reason": null,
  "speech": { "mime": "audio/wav", "sample_rate": 16000, "data_base64": "…" }
}
```

`action` is null or one of `start_guidance{scenario_id}`, `select_step{step_id}`, `ask_clarifying{question_id}`, `locate_item{sku}`, `show_visual{visual_id}`, `read_pulse`, `request_camera`, `capture_camera`, `record_usage{items[{sku, qty}]}`, `start_triage`, `suggest_sos`, or `answer_emergency_question{task_id,question_id}`. The last action is offered only when the request contains `state.pending_emergency_question` with those exact IDs. It never carries answer text; the Pi uses that same turn's final `heard` transcript and its `report.heard` source event. `record_usage` remains in the wire type but is **not offered by the current model schema**, because the minimal screen has no confirmation control. Every ID must come from the request's `state`; the server never returns an ID it was not given, and the box rejects one anyway. `answered_by` is `model` or `fixed`; with `fixed`, `reason` is one of `not_heard`, `no_model`, `timeout`, `model_error`, `invalid_reply`, `refusal`. `speech` is null or `{ "mime": "audio/wav", "sample_rate": 16000, "data_base64": "…" }`; null normally means text-to-speech failed and the Pi speaks the same `reply` locally. `heard` is null when nothing usable was transcribed.

For an audio clip whose transcript is an obvious noise marker or filler only, the server returns `answered_by: "fixed"`, `reason: "not_heard"`, `heard: null`, `reply: ""`, `action: null`, and `speech: null`. The Pi treats exactly this shape as a silent drop and resumes listening. Other fixed replies keep their spoken fallback. Typed text is never subject to this audio transcript filter; short commands such as “help”, “yes”, “no”, “SOS”, and kit item names remain eligible.

Rules: the clip is never stored or logged on either side. For `select_step`, the server maps the chosen ID to canonical scenario text from its own versioned bundle, discards model wording, and synthesizes that exact text with Cartesia. An unknown scenario/step returns `invalid_reply` with no action. For `show_visual`, `state.available_visuals` offers only IDs whose original asset exists on the Pi and whose linked supply is stocked. The server discards model-authored wording and voices the fixed catalog caption from `packages/contracts/src/visuals.ts`; the Pi checks the returned caption and resolves the ID to its local asset. It never accepts a model URL or uses an illustration as medical guidance. The current catalog has a three-slot kit overview and illustrations of scissors, gloves, gauze, antiseptic towelettes, adhesive bandages, medical tape, and an instant cold pack. For an English `locate_item`, the server replaces model wording with a fixed cue naming the offered item and directing the user to the screen and compartment light; the Pi still resolves the actual slot and does not claim a light is on until the board ACKs. The Pi checks a selected guidance ID was offered **and** its returned text matches the local bundle before showing or speaking it; a mismatch is refused. Before any guidance is shown, only the entry content ID is offered. `suggest_sos` starts the **simulated** SOS countdown; it never calls 911. `record_usage` only proposes a usage list when a future confirmation path exists (see `supply.usage_proposed`). `0.1` through `0.7` requests/responses are rejected rather than silently reinterpreted. Compatibility tests must cover: an unknown `step_id`/`question_id`/`sku` rejected, empty allowed lists (the action is then not offered), pending question matching, unoffered visual IDs and missing assets, unrelated speech not being routed, text and audio inputs, selected guidance with and without `speech`, a fixed reply with each `reason`, and old-version rejection.

### Optional guided flows in `voice-turn/0.7`

The Pi offers `state.guided_scenarios[{scenario_id,label,start_step_id}]` only for loaded, source-linked bundles marked `guided: true`, with their required first item stocked. It sets `guided_active` while a guide is running. The model may choose `start_guidance` when the user describes a matching situation and paced help is useful; this is optional, not the response to every request. The server resolves the first step from its own versioned content, discards model wording, and returns that exact text and optional WAV. The Pi checks the same-turn `report.heard`, offered ID, exact local text and stocked item before changing guides, showing the visual or lighting a slot. An untrusted or stale turn cannot start a guide.

For a running guide, `select_step` can repeat the current panel or move to one offered next panel. A next-panel action requires a same-turn, finalized spoken completion such as “done” or “got it”; questions, negation, worsening reports and unrelated speech do not advance. The model may answer those normally, and the person can interrupt with SOS. The server and Pi both enforce the completion guard. `step.done` records navigation after reported completion, not proof of treatment. The current optional bundles are `minor-cut-demo-v2` and `arm-gash-demo-v1`; neither is a diagnosis. English only is offered for guided starts until other-language guards are reviewed.

The model's JSON schema is rebuilt with offered guide IDs and no provider-unsupported numeric constraints; server-side Zod still enforces patient-number and other bounds. A previous triage-capable schema produced provider `model_error` replies on the deployed service. Tests cover the provider schema, guide start, exact-text mismatch, spoken completion, and old-version rejection.

### Core context, pulse and camera additions in `voice-turn/0.6`

The server replaces any box-supplied `state.core_context` with a source-labeled view of this session's last four `report.heard` events, up to six prior action **requests**, and the mock emergency worker's task state. A report is unverified user speech; an action marked `requested` is not proof the Pi performed it. The server keeps the last twelve turns and four idempotent turn replies per lid session in memory for at most thirty minutes. Older reports are reconstructed from the existing event log after a server restart. A cancelled HTTP turn is not added to Core memory. This is a bounded cross-turn action loop, not a general multi-call planner.

`read_pulse` is offered only when the Pi has a connected-board reader. The Pi starts a bounded twenty-second ESP32 MAX30102 sample window in the background, so the person can keep talking. It displays a BPM only from a new `quality:valid` hardware event with its time and device; null/suspect/disconnected results show unavailable. A new user turn cannot silently discard the result: it is queued for Clara's screen and speech after the active turn. Pulse accuracy against a reference remains unverified.

`request_camera` is offered only when the Pi has a camera and configured box credential; the server also requires its box credential and Anthropic key. The bystander's explicit spoken request to take a photo or use the camera grants one cloud-bound frame in that lid session. The Pi checks the finalized `heard` words against the same-turn `report.heard` event and requires both a camera/photo word and an action verb before capture. The grant is consumed once, including on capture failure. The frame is a 640×480 JPEG from the USB camera, captured into memory, sent through `POST /api/boxes/{box_id}/camera`, and zeroed after the request. The route requires a matching bearer credential and open session, a unique consent ID, JPEG bounds, and a frame no older than thirty seconds. It has an eight-second model deadline; the Pi allows ten seconds for the request. The `camera-inspect/0.2` response remains `{schema_version,task_id,status,observation,limitation,captured_at,observed_at}`, but `observation` may now contain up to 1400 characters of visual detail. A multimodal Claude call describes the scene, directly visible spatial details and visibility limits in structured JSON. Obvious clinical or instruction-shaped text is rejected; failure returns `unavailable`, never an invented view. The server holds a successful description only in the matching Core session for two minutes. It does not store or log the JPEG or description in ordinary logs. `capture_camera` remains in the wire union for old clients but is not offered or accepted.

### Camera answer in `voice-turn/0.8`

After a successful inspection, the Pi sends a second `voice-turn/0.8` request containing the original user question and `state.camera_answer_pending:true`. The server replaces box-supplied `core_context` with its own short-lived `core_context.camera:{captured_at,observed_at,description}`. The action schema for this turn allows only `null`; Core Clara uses the image observation as uncertain context to answer the question, ask for a needed fact, or say that the frame is unclear. It cannot start treatment or emergency contact from the image. The Pi presents Core's answer with its Cartesia WAV if available. If a newer user turn arrives, the Pi drops the late background answer; the image context remains briefly available for the person's next question. A failed image-model or Core turn yields an explicit unavailable answer. `0.7` peers are rejected; update the Pi, cloud producer/consumer, schema examples and compatibility tests together.

## Generic presentation — proposed `presentation/1.0`

This is a future contract, not a message the current box or cloud sends. A `presentation.show` request has `request_id`, `session_id`, `turn_id`, `presentation_id`, `input_seq`, `kind` (`answer`, `question`, `diagram`, `item`, `reading`, `guidance`, `handoff`, `status`), `title`, `text`, `speech_segments[{segment_id,text}]`, `source_ref`, optional `asset_id`, `measurement_result_id`, `manifest_rev`, `slot_id`, and a deadline. The result is `committed`, `rejected`, `cancelled`, or `timed_out` with a reason. The Pi owns the commit order; a result with an older `input_seq` cannot replace a newer presentation. Each spoken segment references the committed presentation ID. A guidance card needs an approved protocol bundle and exact text; a reading needs a fresh connected-hardware result; an item card needs a verified manifest and matching layout asset. Asset references resolve only from allowlisted, versioned content. A failure leaves the previous card and simulated SOS available. Adding this wire message later requires a schema, producer, consumer, examples, and compatibility tests in the same change.

## Emergency caller task — proposed `caller-task/0.1`

**No producer, caller subagent, 911 telephony adapter, or real emergency call exists.** The current Pi `emergency.mock_sos` is a separate local simulation. The implemented dispatch coordinator's responder-scout, logistics, and time-to-care subagents do not use this contract and cannot call 911 or speak to the box user.

The future task supervisor accepts `caller.task.start` only after an explicit human SOS or authorized dispatch event. It allocates a `task_id` and deduplicates by `incident_id` plus trigger event. Start contains `schema_version`, `task_id`, `incident_id`, `session_id`, `trigger_event_id`, `authorized_by`, `created_at`, `deadline_at`, and a minimal `known_facts[]` array. Each fact has `fact_key`, `value`, `source` (`gps_fix`, `configured_address`, or `user_report`) and `recorded_at`; a GPS fact also has fix time, freshness, accuracy metadata, and a per-session location-sharing consent ID. The current GPS path remains local to Pi mock SOS coaching; precise coordinates are not sent to the cloud caller without that separate consent. `recorded_at` on a configured address means the record was loaded, **not** that a GPS measurement occurred or that someone verified the address at that time. The caller starts its contact attempt with available facts; it must not await a camera, sensor, model answer, or missing location detail.

```json
{
  "schema_version": "caller-task/0.1", "type": "caller.task.start",
  "task_id": "00000000-0000-4000-8000-000000000101", "incident_id": "00000000-0000-4000-8000-000000000102", "session_id": "00000000-0000-4000-8000-000000000103",
  "trigger_event_id": "00000000-0000-4000-8000-000000000104", "authorized_by": "human_sos",
  "created_at": "2026-11-13T20:00:00Z", "deadline_at": "2026-11-13T20:05:00Z",
  "known_facts": [{"fact_key":"box_location","value":"1455 California Ave","source":"configured_address","recorded_at":"2026-11-13T20:00:00Z"}]
}
```

The caller may emit `caller.fact_needed {task_id, incident_id, question_id, fact_key, prompt_id, requested_at, deadline_at}`. `prompt_id` selects a reviewed Core Clara question template; raw caller/dispatcher text is untrusted and cannot directly become box speech. Core Clara is the **only** user-facing voice. It asks the question while the caller task remains active, and routes only a relevant finalized user response back as `caller.fact_answer {task_id, incident_id, question_id, input_seq, answer_text, source:"user_report", observed_at}`. An unrelated utterance stays in the normal conversation. Ambiguous, absent, expired, or lid-closed responses return `caller.fact_unavailable` with the same IDs and a reason; no answer is guessed. Duplicate, expired, wrong-task, or wrong-question replies are rejected. Multiple outstanding questions are queued with explicit priority so a reply never attaches to the wrong task.

```json
{"schema_version":"caller-task/0.1","type":"caller.fact_needed","task_id":"00000000-0000-4000-8000-000000000101","incident_id":"00000000-0000-4000-8000-000000000102","question_id":"00000000-0000-4000-8000-000000000105","fact_key":"location_detail","prompt_id":"ask_location_detail_v1","requested_at":"2026-11-13T20:00:05Z","deadline_at":"2026-11-13T20:00:30Z"}
{"schema_version":"caller-task/0.1","type":"caller.fact_answer","task_id":"00000000-0000-4000-8000-000000000101","incident_id":"00000000-0000-4000-8000-000000000102","question_id":"00000000-0000-4000-8000-000000000105","input_seq":12,"answer_text":"By the north entrance","source":"user_report","observed_at":"2026-11-13T20:00:12Z"}
```

`caller.task.status` carries `task_id`, `incident_id`, monotonic `seq`, `observed_at`, `task_state` (`queued`, `running`, `needs_fact`, `completed`, `failed`, `cancelled`, `unknown`), `contact_state` (`not_started`, `dialing`, `transport_connected`, `dispatcher_acknowledged`, `ended`, `unknown`), `evidence_ref?`, and `reason?`. A transport connection alone never supports “911 was reached”; only an independently verified dispatcher acknowledgment could support that claim. Core Clara may report only the exact evidenced state. A new user turn or lid close cancels local speech/media, **not** a future authorized caller task. Network loss makes status `unknown` pending reconciliation; no success is inferred or replayed. Actual call cancellation requires a separately authorized request and adapter confirmation. No raw audio, camera frame, sensor reading, or transcript goes into the task by default. Before implementation, add schemas, producers/consumers, reviewed question templates, idempotency and race tests, privacy/telephony/dispatch review, and a human fallback.

## Responder alerts — separate later contract `responder-alert/0.1`

The demo has a working companion response network with test-volunteer alerts and explicit alert states. Its implemented contracts are in `packages/contracts/src/network.ts`; the dispatch coordinator can act on those states through bounded tools. The `responder-alert/0.1` table below is a **separate proposed public responder program contract**, with stronger eligibility, consent, and location-disclosure rules. It is not a deployed integration, and neither network can call 911. The 2.4 `emergency.status` proposal remains mock-only. A public program requires legal, dispatch, privacy, and responder-program decisions before implementation.

| Producer → consumer | Message | Required fields | Rule |
| --- | --- | --- | --- |
| Companion app → responder service | `responder.profile` | `responder_id`, `notification_opt_in`, `availability`, `training[]`, `location_consent`, `coarse_location?`, `last_seen_at` | Only an authenticated responder can change their own opt-in/availability; training has type, verification source/status and expiry. |
| Authenticated SOS service → responder service | `alert.request` | `schema_version`, `request_id`, `incident_id`, `trigger_source`, `reported_need`, `site_id`, `public_site`, `created_at`, `expires_at` | Explicit human SOS or authorized dispatch only; never an agent/camera/sensor inference. Idempotent by incident and request ID. |
| Responder service → selected companion apps | `alert.invitation` | `invitation_id`, `incident_id`, `requested_skill`, `coarse_area`, `expires_at` | Send only to opted-in, available, currently eligible nearby accounts; omit exact incident location and patient/media data. |
| Responder app → responder service | `alert.response` | `request_id`, `invitation_id`, `action` (`accept` or `decline`), `responded_at` | Authenticate responder; reject expired/replayed invitations. Exact location is released only after authorized acceptance. |
| Responder service → initiating UI | `alert.status` | `incident_id`, `state`, `observed_at`, `source` | `requested`, `delivered`, `accepted`, `arrived`, `expired`, `canceled`, or `failed`; each is evidence-scoped. `arrived` needs explicit verified check-in, not GPS proximity. |
| Initiating UI → responder service | `handoff.share.request` | `request_id`, `incident_id`, `handoff_card_id`, `accepted_responder_id`, `sharing_authority`, `expires_at` | Share only after acceptance, authentication and consent/authority checks; never block the initial alert on card generation. |
| Responder service → accepted responder app | `handoff.card` | `incident_id`, `handoff_card_id`, `facts[]`, `steps[]`, `open_questions[]`, `created_at`, `expires_at` | Minimum permitted context with source/time/uncertainty; no raw media by default; revoke on incident cancel/expiry. |

Example future request, **never sent by the demo**:

```json
{
  "schema_version": "responder-alert/0.1", "request_id": "uuid",
  "incident_id": "uuid", "trigger_source": "human_sos",
  "reported_need": "cpr_aed_assistance", "site_id": "public-site-id",
  "public_site": true, "created_at": "2026-11-03T20:00:00Z",
  "expires_at": "2026-11-03T20:05:00Z"
}
```

The initiating UI must show emergency contact and responder alert as **separate** states. Opening a dialer, submitting a request, push delivery and volunteer acceptance are not proof of a completed 911 call or an arriving responder. A candidate with stale location, expired/unverified training, no opt-in, or an ineligible/private site receives no invitation. Expiry or cancellation revokes incident location and handoff access. Future compatibility tests must cover duplicate SOS, opt-out, false alarm/cancel, expired training, stale position, empty matches, push failure, no exact location or handoff before acceptance, forged accept, late accept, no sharing authority, revoked/expired card, and status claims without evidence. New message semantics require a new responder-alert version; they do not silently change demo envelope 2.4.

## Integration acceptance

### Current Core and guidance provenance

`minor_cut_rinse_cover` is the source-linked `minor-cut-demo-v2` rinse-and-cover visual. The server uses its fixed caption and the Pi checks that caption against the local catalog. Both refuse it unless the current utterance explicitly describes a small, minor, superficial, or shallow cut or scrape, without heavy bleeding, a deep wound, a bite, or uncertainty. It is never a generic image recommendation. The exact wording and image are in `content/scenarios/minor-cut.json`; content review is still pending. A locally refused action produces a generic retry line, never the original action promise. `timer.started` records a guidance timer start, not proof of treatment; `step.done` records guide navigation, not treatment completion. The emergency worker keeps wrong-topic utterances as reports but does not complete `people_count` or `location` from them.

Future demo contract tests must cover unknown major (including rejection of the earlier 1.x draft), optional minor field, duplicate/reordered events, MCU reboot sequence reset, lid events without battery telemetry, no invented battery voltage, raw optical sample type, derived-result provenance and window bounds, cancellation race, stale sensor, missing consent, stale/absent GPS fix, mismatched manifest/layout/light mapping, wrong or duplicate LED channel, lid-close/Stop/lease-expiry LED clear, offline reconnect, handoff source/consent filtering, unsupported handoff claims, SOS status ambiguity, duplicate network alert, network alert while offline, alert to a busy box, alert clear and expiry, stale heartbeat shown offline, ack shown as unconfirmed, mount bounce, alarm `off` priority and lease expiry, snapshot never present in session or network payloads, one flag per non-emergency open, supply proposals with unknown SKU or excess quantity rejected, no stock change without `supply.usage_confirmed`, unconfirmed sessions marking slots unverified, and restock clearing them. The ESP32 producer and Pi consumer must use the same 2.4 fixture when implemented; the screen/cloud sensor consumer must reject a purported chip-reported bpm from this breakout. No tests or producers exist yet.

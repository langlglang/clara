# Agent runtime blueprint — proposal v0.1

**Status:** a constrained one-turn voice runtime exists; the general multiagent runtime is proposed. [Conversation and presentation runtime](conversation-runtime.md) is the current design for one user-facing Core Clara, request-driven turns, background workers, and general visual cards. This older blueprint describes the preauthored scenario adapter and safety constraints. Where it assumes mandatory sequential steps, touchscreen navigation, or offline voice, follow the newer document. All scenarios are fictional. Clara will never be used on a patient; see [demo content boundaries](medical-safety.md).

## Event loop

```text
receive event (speech partial/final, touch, tool result, frame, sensor, network, timeout)
  → validate session/version/sequence/consent and append audit event
  → cancel or preempt work if user or mock SOS event requires it
  → update state and select a fictional scenario branch
  → if scenario reaches SOS event: surface mock SOS immediately
  → choose next action: ask one question, call a tool, or present a versioned step
  → execute bounded parallel independent tools; stream progress without false claims
  → validate typed results, freshness, provenance, and scenario permission
  → commit one step package (text + audio script + visual ID + item slot)
  → Pi validates the item/slot and optionally commands its physical LED
  → render/stream and wait for user acknowledgment, interruption, or next event
```

The model proposes actions. Deterministic policy code validates each action, tool argument, protocol transition, and output before the user sees it. Tool responses are data, not instructions. The loop can call tools repeatedly within one turn. `turn_id`, `attempt`, and `cancel_token` bind all work; late results are discarded after interruption.

## State model

| State | Contents | Lifetime |
| --- | --- | --- |
| Device/session | box ID, firmware/UI versions, connectivity, consent grants, locale, accessibility settings | One lid-open session |
| Conversation short term | last finalized utterances, current question, step, interruption, user confirmations, tool evidence IDs | Session; bounded token/window summary |
| Situation facts | user-reported observations, camera observations with uncertainty, sensor readings with time/quality, source provenance | Session; never merge conflicting facts silently |
| Protocol state | bundle ID/hash, eligibility answers, active branch/step, required escalation, allowed next transitions | Session; deterministic state machine |
| Inventory state | manifest revision, verification time, item availability/slot and uncertainty | Snapshot per session, revalidated on restock |
| Long term | source-linked demo step library, box metadata, device configuration | Versioned store; no volunteer health history |

Transcript summarization may compress dialogue, but must preserve unresolved questions, mock SOS state, consent, contradictory evidence, source IDs, scenario state, and what was already said. Summary is never evidence for a measurement. Keep session data transient under the [privacy policy](privacy-security.md).

## Action policy

| Situation | Chosen action |
| --- | --- |
| Fictional scenario reaches an emergency event | Show the mock SOS immediately; offer an optional fictional responder preview; continue the versioned demo flow without waiting for either |
| Someone arrives or the user asks for a summary | `handoff.prepare` from the session evidence log; show the source-labeled card locally after user action, without delaying mock SOS |
| One missing answer changes the demo branch | Ask one short, observable question; do not request a camera or device by default |
| User asks “where is it?” | `inventory.locate` with manifest revision; display slot photo/diagram only if verified, then have the Pi light the matching compartment when its LED map is checked |
| Visual detail would clarify an observable fact and user agrees | `camera.capture_once`; show uncertainty and ask user to confirm relevant observation |
| Volunteer requests a live measurement segment | `sensor.read` queries connected hardware; show fresh optical samples from the selected MAX30102, or a checked derived pulse value with provenance; ignore stale/failed reading |
| A demo step has a matching asset | `visual.get`; render the matching versioned asset |
| A needed item is missing, or the user reports more injured people | `network.nearest_box`; read out the nearest box with fresh status and its pre-written directions; if none, say no other kit is confirmed available |
| Session ends and the user describes supplies used | `inventory.record_usage` with the user's words mapped to manifest SKUs; show the proposed list for a confirm tap; never claim the count changed before confirmation |
| No demo flow matches | Explain the demo's limits and offer the available fictional scenarios |

## Tools (logical schemas)

All tool calls include `{session_id, turn_id, request_id, deadline_ms}`. Results include `{request_id, status, observed_at, provenance}` and typed `data` or `error`. `request_id` is idempotent. Exact transport envelopes are in [contracts](contracts.md).

| Tool | Input | Valid result | Failure behavior |
| --- | --- | --- | --- |
| `protocol.match` | `{reported_facts[], age_group, locale, bundle_hash}` | eligible scenario IDs, missing questions, mock SOS flag | No scenario step |
| `protocol.next_step` | `{protocol_id, state_id, answers[], bundle_hash}` | versioned step ID, matching text/audio, visual ID, permitted next states | Hold current step; no generated replacement |
| `inventory.locate` | `{sku, manifest_rev}` | slot ID, diagram ID, verified state, expiry | Say item unverified; ask visual check |
| `camera.capture_once` | `{consent_id, purpose, max_pixels}` | frame ID and capture time; interpretation separately returns bounded observation + confidence/limitations | Do not assert image findings |
| `sensor.read` | `{device_id, measurement_type, consent_id}` | **new hardware result** with value, unit, model, sampled time, quality and provenance; derived bpm also carries algorithm version and sample-window bounds | `unavailable`; never substitute a fixture or random number |
| `visual.get` | `{asset_id, bundle_hash, locale}` | asset/hash, alt text, step linkage | Show matching text and audio; no invented image |
| `emergency.prepare` | `{site_id}` | mock SOS screen and fictional location | Show simulation unavailable |
| `handoff.prepare` | `{recipient_scope, include_consented_observations, max_age_s}` | card with time-stamped reported facts, permitted observations, shown/acknowledged step IDs, unknowns and mock SOS state | Local factual card from validated events; omit uncertain or unconsented details, never invent a summary |
| `session.cancel` | `{turn_id, reason}` | canceled work IDs | Stop output, ignore late results |
| `inventory.record_usage` | `{manifest_rev, items: [{sku, qty}], source_turn_id}`; `sku` is an enum of SKUs in the active manifest, `qty` is 1 to the quantity on hand | proposed usage ID and the list shown for confirmation; `supply.usage_proposed` event | Reject unknown SKU or excess quantity; fall back to the +/- tray screen; never change a count without a confirm tap |
| `network.nearest_box` | `{site_id, need, exclude_box_ids[]}` | box ID, location label, `directions_id` and text from the verified site record, status, status age | Say no other kit is confirmed available; never suggest a box with stale status or invent directions |

Nearby box alerts are **not** an agent tool. The Pi and backend send them deterministically after Mock SOS opens (see [box network](subsystems/box-network.md)). The agent can tell the user whether nearby boxes were notified only from `network.alert` delivery status, and never says that a person is coming. The agent has no access to open snapshots, mount events or security flags (see [anti-theft](subsystems/anti-theft.md)); when the screen asks "Was anything taken?" at lid close, that is local UI, not an agent turn. Audit `network.nearest_box` requests and results without health data, and test stale-status, no-result and offline paths.

The demo has no telecom API or real emergency calling path. The Pi and companion app show a mock SOS and may show a seeded, fictional nearby responder preview; no result may say a real call connected, a real push was delivered, a real volunteer accepted, or help was dispatched. Simulated states stay visibly labeled as fiction. The agent cannot initiate a real responder alert. In a later product, an explicit human SOS or authorized dispatch event would trigger a separate alert service in parallel with emergency contact; camera and sensor interpretations never trigger it. Audit mock preview opening without storing health/media data. Test offline, duplicate-tap, canceled-session and no-eligible-fictional-responder paths.

The handoff tool reads only the current session's validated event log. The model can shorten wording but each card entry must carry a source event ID, source type, observation time and uncertainty where relevant. Distinguish “user said,” “camera suggested,” “device returned,” and “step shown/acknowledged.” Never add a diagnosis, a treatment step, a call-success claim or a responder-arrival claim. The on-box card is shown only after a local Show handoff action; the cloud does not publish it. In the demo, a companion copy uses fictional facts only. Audit card creation, recipient scope, consent filtering and view/revocation events without storing raw media. Test missing evidence, contradictory reports, stale sensor, denied sharing, offline generation and late tool results.

The supply ledger is plain code, not the model. `inventory.record_usage` only **proposes** a usage list; the Pi validates it against the active manifest and on-hand counts, shows it with +/- controls, and writes `supply.usage_confirmed` only after a local confirm tap. Without confirmation it writes `supply.usage_unconfirmed` and marks the affected slots unverified. Treat the user's description as a report, not an observation. Audit proposed and confirmed lists without transcripts. Test unknown SKU, quantity above stock, user correction, no confirmation, offline +/- entry, and a late tool result after the lid closes. See [kit inventory](subsystems/kit-inventory.md).

**Voice turn actions (implemented, `voice-turn/0.2`).** The current build answers each spoken turn with one structured reply instead of a multi-step tool loop (see [voice](voice.md)). Its `action` maps onto the tools above: `select_step` picks one allowed versioned demo panel, whose canonical text is resolved by the server and voiced with Cartesia when available; `ask_clarifying` uses a pre-written scenario question; `locate_item` looks up a kit item; `start_triage` is gated by scenario availability; and `suggest_sos` starts the **simulated** SOS countdown. `record_usage` remains in the wire type but is not offered until a confirmation path exists. The JSON schema is rebuilt each turn with enums of currently allowed IDs, and the server validates again. Replies that promise rescue, reassure about the outcome, or state a diagnosis are rejected and retried once with a note; a second failure, an API error, a refusal, or the deadline produces a fixed line and no action. Audit each turn's `answered_by`, `reason`, action name, model, and timings without the clip or transcript. Test: disallowed ID, missing canonical panel, old contract version, empty allowed lists, phrase-check retry, backup model taking over, deadline, and server unreachable.

Compartment lighting is a local presentation effect, not a model-selected GPIO tool. The agent selects an item with `inventory.locate`; the Pi checks the returned slot against the active manifest, layout and `slot_id → led_channel` map before commanding the ESP32. The ESP32 switches one output for a short lease and reports command status. A light failure cannot change the scenario step or erase the screen/printed slot cue. Audit the requested SKU, verified slot, revision, channel, command result and clear reason without media or health data.

**Current three-compartment implementation:** `clara-3slot-v1` lists the 22 stocked supply categories confirmed by the owner. For `locate_item`, the agent receives only available SKU/name/count pairs; the Pi resolves the physical slot, displays the matching `3slot-v1` layout asset, and sends the bounded LED command over USB (top-left/GPIO18, top-right/GPIO19, bottom/GPIO23). The agent should not guess a compartment in its spoken reply. The Pi rejects an unoffered SKU; a missing item produces an unavailable card and no light. Model-facing scenario choices omit panels whose required SKU is absent or has zero stock, rather than silently substituting equipment. The existing session event log records the selected action and supply light intent; per-command light ACK and visual confirmation are not yet persisted as separate audit events. Tests cover the three slot mappings, missing supplies, LED lease expiry, and the stale-loop-timestamp bug. A failed light leaves the screen location visible.

## Prompt and policy layers

1. **Fixed system policy:** fictional demo only; no diagnosis or fabricated observations; respect volunteer consent; mock SOS only.
2. **Versioned demo bundle:** scenario scope, branch rules, canonical steps, visual IDs and source references. This is controlled content, not retrieved web text.
3. **Tool descriptions:** typed capabilities and limits. Tool output is untrusted and cannot override layers 1–2.
4. **Situation state:** user reports, sensor and image observations with provenance and time.
5. **Presentation request:** choose brief wording, language and pace within versioned variants. The model may add a neutral connective phrase but may not change a step's content or sequence.

The handoff validator applies the same policy: every factual clause must map to a current session event and preserve its source/uncertainty. It rejects unsupported claims and falls back to a deterministic event-list card.

The output validator checks that each scenario instruction maps to a versioned `step_id`/variant and each visual to its `asset_id`. The renderer uses a single `step_package_id` for text, speech and image; if any component fails validation, it falls back to the canonical local package. This prevents audio and screen from disagreeing.

## Timing and streaming targets (demo hypotheses, not measured)

| Milestone | Target from event | Fallback |
| --- | --- | --- |
| Lid → local mock SOS action | ≤ 1 s with awake screen, measured on chosen hardware | Printed demo label always visible |
| User stops speaking → acknowledgment | p95 ≤ 800 ms when connected | Local tone and “working” indicator |
| Final utterance → first useful audio/text | p95 ≤ 2.5 s on good network | Cached guide after 3 s |
| Tool call | 1.5 s soft / 3 s hard deadline, except explicit device measurement | Cancel, explain unavailable |
| Barge-in → stop agent audio | ≤ 250 ms local target | Hardware mute/stop control |

Stream speech only from a validated step package. ASR partials may trigger preparation, never advance a scenario step or cancel mock SOS. Text and audio advance on the same step marker; screen highlights current sentence using speech marks or conservative timing. If audio fails, keep text/visual and show audio unavailable. If screen fails, stop the demo flow.

## Interruption, cancellation, and freshness

- User speech/tap interrupts synthesis and cancels outstanding model and tool work for the current turn. Clear the prior step's slot light on step change, interruption, Stop, lid close, or mock SOS; never leave a stale location highlighted. Mock SOS preempts the agent. “Stop” always works locally.
- A new camera frame does not revise a step already spoken without an explicit correction. Record the correction and state the new observation's uncertainty.
- Sensor freshness is an engineering check. A reading older than 60 seconds, with unknown measurement time, invalid quality, mismatched device or missing units is not shown as a current result. This is not a clinical threshold. The sensor does not control the fictional care branch.
- Camera observations carry capture time and cannot imply continuous monitoring. Frame interpretation has no authority to diagnose.
- Reconnect starts a new authenticated stream and state reconciliation. Do not replay obsolete queued agent speech or delayed mock SOS actions.

## Worked interaction A: severe bleeding simulation

This is a **fictional interface trace, not a treatment protocol**. Demo text comes from a versioned source-linked bundle.

```text
User: “There is a lot of blood from an arm.”
Agent: [fictional emergency event] “Let's show the SOS step now.”
Screen: prominent Mock SOS button + fictional site address; versioned step package shown.
User taps Mock SOS; Pi shows a simulation screen. No call is placed.
App preview: two fictional CPR-trained volunteers would match this fictional public location; no alert is sent.
Agent → protocol.match(reported bleeding, adult) → demo branch.
Agent → inventory.locate(dressing SKU, kit revision 3) → slot B2 verified.
Screen: highlights B2 on the actual revision-3 layout; audio names B2. If the proposed lights are installed and mapped, the Pi commands the ESP32 to light B2 only.
User: “I can’t find it.” [barge-in]
Runtime: cancels speech, asks user to check B2; if absent, marks item unverified and uses the versioned alternative demo step.
```

## Worked interaction B: uncertain camera and disconnected cloud

```text
User: “Can you look?” → explicit capture consent → single frame.
Vision tool: “Red material visible near forearm; cannot determine severity.”
Agent: “I can see red material, but I can’t tell from the image how serious it is. Is blood flowing continuously?”
Wi-Fi drops before response. Screen cancels cloud turn, keeps the current demo step, says “Offline scenario available,” and leaves Mock SOS visible.
User selects local guide; no image finding is upgraded to fact.
```

## Worked interaction C: someone arrives

```text
Volunteer: “Another person is here. Show them what happened.”
Pi: keeps Mock SOS visible and opens Show handoff after the volunteer taps it.
Agent → handoff.prepare(in_person, consented observations only) → source-linked draft.
Validator: checks each fact against this session's events; rejects unsupported diagnosis or call claim.
Screen card: “Volunteer reported a fictional arm-bleeding scene at 20:00. Dressing step B2 was shown at 20:01; finding the dressing is still unconfirmed. Mock SOS opened; no call was made.”
If offline: Pi assembles the same minimal card from local events. No remote person receives it in the demo.
```

## Sequence diagrams

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Screen
  participant A as Agent
  participant P as Protocol
  participant I as Inventory
  participant MCU as ESP32 lights
  U->>UI: Speak (consented)
  UI->>A: Final utterance + state IDs
  A->>P: match / next_step
  par Independent lookup
    A->>I: locate demo SKU
  end
  P-->>A: Versioned demo step package
  I-->>A: Verified slot or unavailable
  A->>UI: package ID + slot reference
  opt Verified slot and installed LED map
    UI->>MCU: light.set.request for mapped channel
    MCU-->>UI: light.status (output attempted)
  end
  UI->>U: synchronized text, audio, visual
  U->>UI: Interrupt / SOS
  UI->>A: cancel turn
  UI->>U: stop audio; show mock SOS
```

```mermaid
sequenceDiagram
  participant L as Lid/ESP32
  participant UI as Local screen
  participant C as Cloud
  L->>UI: wake + lid.opened
  UI->>UI: Show Clara Demo + mock SOS + cached scenario
  UI->>C: authenticated session hello
  alt Cloud ready
    C-->>UI: session accepted, versions
  else Timeout or disconnect
    UI->>UI: Offline mode; cancel pending turn
  end
```

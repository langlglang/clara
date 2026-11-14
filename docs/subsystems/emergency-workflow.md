# SOS and team dispatcher — proof of concept

The HackPrinceton build uses a local SOS action and an optional Twilio call to a **team-owned dispatcher phone**. It never calls 911. A large SOS button works without the cloud agent, microphone, camera or sensor; a model-selected `suggest_sos` can also start it. The Pi does not replace the current visual with a call screen or call timer. Core Clara remains available to speak with the person and presents a short status line only when there is an actual state change. The local countdown runs in the background, and duplicate taps keep one SOS session. While offline, the action remains available but a call cannot be claimed. The proof-of-concept nature of the build remains documented here; the kiosk does not claim public emergency services were reached.

The Pi sends the cloud `sos.opened` event and a source-labeled `emergency.context` after its countdown. A fresh GPS fix is sent if available; otherwise it sends the configured address, then `unavailable`. The phone's opening briefing omits the location entirely. The dispatcher conversation can answer a location question from this context. The current demo sends location to the cloud without a per-session location-sharing prompt; that consent decision must be resolved before any patient use. `placed` indicates Twilio accepted a request to the team number, **not** that it rang or was answered. The Pi speaks that limited result; `failed` and `not_configured` produce a direct-phone fallback line. The Pi never says that it reached 911.

**Demo implemented, physical check pending:** an independent backend fact worker starts when an incident opens. It receives the fresh GPS fix, configured address, or `unavailable` from the Pi. It may request the situation or location when those facts are missing; it does not automatically ask how many people need help. The Pi ignores push wording as an instruction and speaks its own fixed prompt through Clara's speech queue, with a secondary caption; it keeps any current guidance visual on screen. A people-count push from an older worker is ignored. Canonical Cartesia audio is optional. A matching `answer_emergency_question` action sends the exact finalized user words, linked to the preceding `report.heard` event, back to the worker. The user can continue an ordinary conversation while this task runs. The model is instructed to leave unrelated words in the normal conversation; the code validates task IDs and transcript provenance, while semantic answer matching still needs scenario tests. The question expires after 120 s or clears on lid close. The worker reports `collecting_facts`, `facts_ready`, or `cancelled` and **never dials**. See the implemented [events/0.2 and voice-turn/0.3 contracts](../contracts.md).

**Demo implemented in code, phone delivery unverified:** a separate `demo911` adapter may ring the team-owned number through Twilio about four seconds after SOS opens. It requires Twilio credentials and `CLARA_DEMO_911_NUMBER`; the target is validated as a full E.164 number, and emergency short codes are refused. Missing configuration produces `not_configured`. One call is attempted per incident. The spoken opening contains the recorded incident facts but no address, GPS coordinates, hackathon wording, or simulation stagecraft. The dispatcher may ask for location afterward. With a supported two-way route, the call worker can receive dispatcher speech and relay questions to Core Clara; Core remains the only box voice. Twilio's trial-template fallback may be one-way. The call adapter pushes `dispatcher.call_status` with `placed`, `failed`, or `not_configured` to the box, which accepts only a matching lid session. Neither path calls 911 or claims a dispatcher answered without evidence.

**Demo implemented in code; live voice check pending:** one request such as “Start dispatch and help me use gauze for this arm wound” can launch the SOS task and the source-linked arm guide together. Clara says she is starting the dispatch request, displays and lights the verified gauze compartment, then speaks the guide while SOS runs behind it. The five-second countdown and later call-status push do not replace the guide visual or cut off its speech. If the phone API accepts the call request, Clara announces that narrow fact; if it fails, she says so. Neither status means a person answered. Pulse or camera tasks may also launch from the same turn when explicitly requested and available; their results remain independent of SOS and guidance. A missing visual or sensor result cannot undo an already started SOS. The screen still shows only one primary presentation at a time.

**Demo implemented in code; physical check pending:** the on-box handoff summary uses fixed templates over this box's own session events and can work offline. It labels bystander speech as reported, guidance as steps shown, and a valid pulse result as a device reading; it does not claim that a treatment happened. The current minimal kiosk does not expose the old Show / Read Summary button. When the server opens the incident, `incident.opened` supplies a token-backed report URL and a six-character short code for the separate report route. Unknown or colliding short codes return 404. The link is not shown in the minimal kiosk; neither it nor the local summary indicates that emergency services were reached.

**Draft scenario implemented in code; content and physical review pending:** `not_breathing/draft-1` can open the simulated SOS countdown and show a 110 bpm CPR coach with LED beat, generated audio ticks, fixed spoken reminders, and a screen beat count. The number counts scheduled beats, not observed compressions. A missing pulse result from the connected sensor may ask the bystander to check responsiveness and breathing; it never starts CPR on its own. Only the bystander's answer can take the shortcut into the coached step. The user can stop the coach; scenario change and session close stop it too.

## Independent caller task — future architecture

In a future system with a reviewed 911/dispatch integration, explicit human SOS or authorized dispatch would launch a dedicated caller subagent. **This is proposed, not in the hackathon demo.** The caller starts contact using known, source-labeled session facts and the configured public box address; a fresh GPS fix may leave the Pi only after explicit per-session location-sharing consent. It does not wait for missing answers. Core Clara remains the sole voice talking to the box user and continues other help while the caller works. If the caller needs a detail, it sends a `caller.fact_needed` event tagged with `task_id` and `question_id`. Core Clara asks the reviewed question, then returns only the relevant finalized user reply with those IDs and `source:user_report`. Silence, an unrelated reply, or uncertain transcription never becomes a fabricated answer. If the lid closes, the unanswered question becomes unavailable while the caller continues its authorized attempt. The caller keeps its own status and deadline; a cancelled conversation turn or closed lid does not silently cancel an authorized call. See the proposed [caller-task/0.1 contract](../contracts.md).

The current local SOS is independent of the cloud turn, camera and sensor. The optional team-phone adapter dials only the configured team number. For a future real emergency call, an attempted dial or transport connection is not proof that a dispatcher answered; the user-facing status must come from verified adapter evidence. On network failure the state is unknown until reconciled, and the box must keep a direct human emergency path available. Real cancellation, privacy, telecom reliability, dispatcher integration, and jurisdictional review remain unresolved before any deployment.

## Nearby trained volunteer concept

The companion app should eventually be able to invite **opted-in, available, nearby volunteers with relevant training** (for example, CPR/AED training) when an eligible SOS occurs. This is a separate, later capability. It must run **in parallel with**, never before or instead of, contacting emergency services. A user can always reach the emergency action without the agent or responder network. [911.gov](https://www.911.gov/calling-911/frequently-asked-questions/) describes the information a caller should give emergency dispatch; [PulsePoint's existing responder program](https://www.pulsepoint.org/pulsepoint-respond) illustrates a dispatch-coordinated, opt-in model for public cardiac-arrest events. Clara has no affiliation or integration with either service.

For a real system, the trigger must come from an explicit human SOS or an authorized dispatch signal, not an agent's camera or sensor guess. Limit CPR/AED alerts to a human-reported or dispatch-confirmed eligible event; do not infer that CPR is needed from a device reading. A responder profile needs notification opt-in, current availability, location-sharing consent, training type, verification status and expiry. Restrict public volunteer alerts to eligible public locations until a jurisdiction and partner approve a broader policy. Do not label a self-reported skill as verified or a volunteer as an official responder.

The alert service would match only the minimum necessary nearby candidates, deduplicate one incident, rate-limit abuse, and expire unanswered invitations. An invitation should reveal a coarse area and requested skill; disclose the exact incident location only after the recipient accepts and the policy allows it. Do not send patient identity, camera frames, health readings or transcripts. Show distinct states for **requested**, **delivered**, **accepted** and **arrived**; never turn a push receipt into “help is coming.” If network, location, push delivery or matching fails, the emergency action continues and the interface says the volunteer request is unavailable or unconfirmed. Cancel/resolve the incident and revoke location access when it ends. A real deployment would need dispatch coordination, identity/training verification, consent, privacy, liability, misuse and false-alarm review before sending any alert.

The current **demo response network** can alert enrolled test volunteers through the companion app and can record sent, shown, accepted, and arrived states. The implemented dispatch coordinator can run a deep agent with responder-scout, logistics, and time-to-care subagents when enabled with a model key; its tools are bounded by deterministic checks. It does not speak to the box user or contact 911. It is separate from the proposed caller task. Only a confirmed accept may produce “is coming,” and no notification receipt proves arrival. Wider public responder deployment still needs the program and safeguards above.

## Context for someone arriving

The implemented on-box summary is deliberately narrow: it uses fixed templates over this lid session’s local events, can be shown or read during mock SOS, and includes no camera frames or unconsented measurements. A richer handoff worker that drafts context for a specific arriving person remains **proposed**. It would need source/time labels, separate sharing authority for camera or sensor observations, and validation against the event log. No model-generated handoff or remote sharing is implemented.

In a later real responder network, the same minimum context could be shared with a specific invited person **after they accept and authenticate**, subject to explicit sharing authority and a short expiry. The first alert contains no patient details and is never delayed while the agent prepares a summary. Separate the incident location, user-reported facts, device observations and actions already taken. Show source/time/uncertainty and allow revocation. Do not include raw audio, images or a transcript by default. If summary generation fails, share no invented details; emergency contact and the responder invitation continue.

```mermaid
sequenceDiagram
  participant U as Box user
  participant UI as Box or companion app
  participant S as Local SOS
  participant R as Demo response network
  U->>UI: Tap SOS
  UI->>S: Start locally (works offline)
  S-->>U: Clara status in ordinary voice and visual
  opt Another person arrives
    U->>UI: Show handoff
    UI-->>U: Source-labeled fictional context card
  end
  opt Demo network is connected
    UI->>R: Publish mock incident once
    R-->>UI: Sent / shown / accepted states with evidence
    UI-->>U: Report confirmed status only
  end
```

Later concept, **not a demo data flow**:

```mermaid
sequenceDiagram
  participant U as Initiator
  participant E as Emergency contact path
  participant S as Responder service
  participant R as Opted-in responder app
  U->>E: Start emergency contact immediately
  U->>S: Explicit SOS for eligible public event
  S->>R: Minimal invitation (skill + coarse area)
  R->>S: Accept, if available
  S-->>U: Accepted status (arrival unconfirmed)
  opt Initiator authorizes context sharing
    U->>S: Share expiring source-labeled handoff
    S->>R: Card after acceptance + authentication
  end
```

Acceptance: the local SOS action works offline, after a denied camera permission and after a sensor error. A connected demo-network alert is deduplicated and its delivery and acceptance are reported separately; an offline box does not claim a volunteer was notified. A future handoff card must label reported versus observed facts, omit unconsented media/measurements, and never claim an unperformed action or contacted responder. Duplicate taps do not create duplicate incidents. No call-specific overlay appears, and a `placed` status never becomes a claim that 911 or a dispatcher answered. The public AED and disaster setting motivates the concept, but placement and real emergency communications are outside this project.

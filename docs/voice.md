# Voice conversation — proposed design

**Status:** proposed. A scaffold exists in `server/` and `box/` (see "Code" below), but nothing has run on the Pi, against Cartesia, or against Claude yet. Clara is a proof of concept and will never be used on a patient.

This page describes how a bystander talks to Clara and how Clara answers. The approach follows the team's earlier Cal Hacks project (Sophi): the box records a short clip, a server turns it into words, Claude picks one allowed action, and the server sends back a short spoken reply. The code here is written fresh for Clara.

## The loop in one picture

```text
Box (Pi, Node/TypeScript)                       Server (Node/TypeScript)
─────────────────────────                       ─────────────────────────
session active (lid open) → mic listens
voice-activity detection ends a clip
  (0.7 s silence, 0.3 s min, 15 s max)
16 kHz mono WAV, in memory only
POST /v1/boxes/{id}/turns  ───────────────────► 1. speech-to-text (Cartesia ink-whisper,
  { audio or text, language,                       chosen language) → words
    scenario state: current step,                2. Claude: cached system prompt + this
    allowed next steps, questions,                  turn's context as JSON → one JSON reply,
    kit manifest, recent turns }                    schema built from the allowed options
                                                 3. validate (zod) + phrase check;
                                                    one retry with a note, else a fixed line
                                                 4. text-to-speech (Cartesia sonic) only when
                                                    the reply has words to say
            ◄──────────────────────────────────  { heard, reply, action, speech? }
select_step → play the step's LOCAL recorded audio
other reply → play the server's speech (or Piper /
  espeak-ng on the box if it is missing)
mic resumes after playback (half-duplex)
```

## Key choices

| Choice | Why |
| --- | --- |
| **Hands-free while a session is active**, plus a large on-screen **Talk** button | A bystander's hands are busy. The button is the backup when the room is loud or the detector misses. |
| **Half-duplex:** the mic pauses while the box speaks or waits | Stops the box hearing itself. Tapping **Stop** or **Talk** interrupts playback. Voice "stop" during playback needs echo cancellation and is a later step. |
| **A clip per utterance, not streaming** | Simple, reliable, and easy to test. Streaming speech-to-text is a later optimization. |
| **All model and voice calls on the server** | API keys never live on the box. The box stays simple. |
| **Structured JSON reply, not tool calling** | One call returns the transcript, a short reply, and at most one action. The current models reject forced tool choice, so a JSON schema is the reliable way to get exactly one decision. |
| **The schema is rebuilt every turn** | `step_id`, `question_id` and `sku` are enums of what is allowed **right now** (the scenario's next steps, its questions, the kit manifest). Claude cannot name a step that isn't allowed; the server checks again with zod. |
| **Steps play local recorded audio** | When Claude picks `select_step`, the server returns only the step ID. The box plays the step's pre-recorded audio in the chosen language immediately, with no text-to-speech wait. Only clarifying replies are synthesized. |
| **Main model plus backup** | Claude Haiku 5.5 answers; Claude Opus 5.5 is asked at the same time and its answer is used if Haiku hasn't answered after 2.5 s. |
| **Every call has a deadline** | A turn always ends, with a fixed line if anything fails. The touch flow never depends on voice. |

## Reply shape

```json
{
  "transcript": "copy of the words heard",
  "reply": "at most two short sentences; may be empty with select_step",
  "action": null
    | { "name": "select_step",    "step_id": "<enum: allowed next steps>" }
    | { "name": "ask_clarifying", "question_id": "<enum: scenario questions>" }
    | { "name": "locate_item",    "sku": "<enum: kit manifest>" }
    | { "name": "record_usage",   "items": [{ "sku": "<enum>", "qty": 1 }] }
    | { "name": "start_triage" }
    | { "name": "suggest_sos" }
}
```

- `select_step` is the only way guidance advances. Step text and audio come from the scenario bundle, never from the model.
- `ask_clarifying` picks a pre-written question; the box speaks its recorded audio when it has one.
- `locate_item` lights the slot through the existing inventory path ([kit inventory](subsystems/kit-inventory.md)).
- `record_usage` only **proposes** a usage list; the screen asks for a confirm tap ([kit inventory](subsystems/kit-inventory.md)).
- `suggest_sos` highlights the SOS control. Only a person's tap opens SOS ([emergency workflow](subsystems/emergency-workflow.md)).
- Actions an action list doesn't currently allow (for example `start_triage` when triage isn't available) are left out of that turn's schema.

## Phrase check

Before a reply is spoken, the server rejects it if it:

- promises rescue ("help is coming", "an ambulance is on the way", "I called…");
- reassures about the outcome ("you'll be fine", "everything will be okay");
- states a diagnosis ("it's broken", "you have a fracture", "diagnosis").

A rejected reply is retried once with a short note naming the rule. A second failure, an API error, a refusal, or the deadline returns a fixed line ("I didn't catch that. Tap the step on the screen, or tell me again."). These checks are a guard, not a guarantee; the policy also says so in the system prompt.

## Latency budget (targets, not measured)

| Stage | Target |
| --- | --- |
| End of speech detected | 0.7 s of silence |
| Upload + speech-to-text | ≤ 1.0 s |
| Claude (Haiku, effort low; Opus backup after 2.5 s) | ≤ 1.5 s typical |
| Text-to-speech (clarifying replies only) | ≤ 0.8 s |
| **End of speech → first audio** | **about 3–4 s**; a step chosen by Claude starts as soon as the reply arrives |
| Server turn budget | 6 s; box deadline 8 s |

The box plays a short "listening" tone when the mic opens and a "got it" tone when a clip is sent, so silence never feels like a crash.

## Failures

| Failure | Behavior |
| --- | --- |
| No network or server timeout | The box says a local line and keeps the touch flow; the current step stays on screen. |
| Speech-to-text fails or hears nothing | Fixed "didn't catch that" line; no model call. |
| Claude errors, refuses, times out, or breaks the schema twice | Fixed line; current step unchanged. |
| Claude names a step that isn't allowed | Rejected by the schema enum and again by zod; treated like a broken reply. |
| Text-to-speech fails | The box speaks the reply with Piper, or espeak-ng if Piper is missing. |
| Step audio file missing | The box speaks the step text locally. |
| Clip under 0.3 s | Dropped silently (a cough or a bump). |
| Clip reaches 15 s | Sent as is. |
| A player hangs | Stopped after a per-line limit; the queue moves on. |

## Privacy

Clips exist only in memory and in the one request body. The server sends the clip to Cartesia for transcription and nowhere else; only reply text goes to text-to-speech. Neither side writes audio or transcripts to logs. See [privacy and security](privacy-security.md).

## Languages

The box sends the session's language with every turn. The server passes it to speech-to-text and text-to-speech, and tells Claude to reply in it. Step and question audio are recorded per language under `content/audio/<lang>/`. Check that Cartesia supports the second language for both directions before choosing it.

## Code (proposed scaffold)

| Path | What it does |
| --- | --- |
| `packages/contracts` | Turn request and response schemas (zod), shared by box and server |
| `server/` | `POST /v1/boxes/:id/turns`: Cartesia speech-to-text and text-to-speech, Claude reply with per-turn schema, phrase check and retry, main/backup hedge, deadlines, stubs when keys are missing |
| `box/` | Mic capture (`arecord`), voice-activity detection, speech queue (`aplay`, Piper, espeak-ng), cloud client, scenario state, and a simulator for a laptop (typed text or WAV files) |

Run it: see [the code README](../server/README.md). Keys: `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY` on the server only.

## Later

- Streaming speech-to-text and partial results to cut a second.
- Echo cancellation so "stop" works by voice during playback.
- Multi-step tool loop (camera frame, nearest box) as in [agent runtime](agent-runtime.md).

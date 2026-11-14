# Voice conversation

**Demo implemented:** the Pi listens only while the lid is open, ends a clip using voice activity detection, and sends one turn to the box API. The cloud turn can use Cartesia speech-to-text, a constrained Claude decision, and Cartesia text-to-speech; a keyword stub works without keys. The Pi has local speech fallback. The current model selects at most one action from a scenario-specific schema. **Demo verified on Pi:** the deployed service reports a hands-free audio path and the idle screen shows MIC OFF; a live lid-open voice turn after this change has not been exercised. **Proposed:** one persistent user-facing Core Clara with tool calls and background workers; see [conversation runtime](conversation-runtime.md).

Opening the lid creates a local session and enables the microphone. It makes no model call and does not show the first scenario panel. Closing the lid stops capture and cancels active voice work. Each final utterance is an actual request. Silence, mic noise shorter than the endpoint threshold, and partial transcripts must not request model work. The user never needs the screen to begin or continue talking.

```text
lid open → local mic starts → final utterance → POST /v1/boxes/{id}/turns
  → optional speech-to-text → model decision → server validation
  → action on Pi + optional synthesized speech → mic resumes
lid close → stop mic, speech and in-flight turn
```

The current endpoint uses 16 kHz mono WAV held in memory, 0.7 s end silence, 0.3 s minimum speech, and a 15 s maximum clip. It is half-duplex: capture pauses during box speech to avoid hearing itself. Voice interruption during playback needs echo cancellation and remains proposed. The box has an 8 s deadline and uses a fixed failure line on timeout; it keeps the last visual and simulated SOS available. There is no touch Talk, Next, Back, or Repeat control. Cloud conversation is unavailable during a disconnect.

A turn carries session ID, language, recent turns, current scenario ID/step if any, allowed content IDs, questions and inventory. The server rebuilds a strict schema each turn and checks the model result again. `select_step` plays source-linked local audio and shows its matching panel; `ask_clarifying` uses an approved question; `locate_item` resolves a verified manifest item; `suggest_sos` starts the **simulated** countdown; `start_triage` is offered only where enabled. `record_usage` is currently **not offered** because the minimal screen has no confirmation control. The protocol still recognizes it for compatibility. The model cannot return its own measurement or a diagnosis. A generic `presentation.show` card and multiple background jobs are proposed, not part of this turn API.

The server rejects a reply promising rescue without acceptance, claiming a diagnosis, or falsely reassuring about the outcome. It retries an invalid model shape once, then returns a fixed line. Speech-to-text failure, model timeout, or network loss never produces a guessed answer. Sensor reads must come from wired hardware with units and time. Camera use needs per-session consent and uncertain interpretation must be described as uncertain. Audio and transcripts are not written to ordinary logs; see [privacy and security](privacy-security.md).

Latency targets, not measured guarantees: about 700 ms for speech endpointing and 3–4 s from end of speech to first response. The current server turn budget is 6 s; the Pi deadline is 8 s. Later streaming speech and synchronized visual segments are specified in [conversation runtime](conversation-runtime.md).

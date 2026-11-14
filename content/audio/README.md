# Lid-open greeting audio

`clara-greeting-v3.wav` is a fixed 6.96-second, 16 kHz mono PCM recording in Clara's Cartesia voice. Its complete spoken text is **“I'm Clara, I'm here to help. Let me know what happened and I can guide you through treatment, diagnosis, or call for help.”** It was captured from the project's configured Cartesia voice on 2026-11-13 and checked by sending the final WAV through the live speech-to-text endpoint, which returned the exact words (with a punctuation difference after “Clara”). This is scripted demo copy, not a claim that the present agent diagnoses or places a real 911 call.

The Pi plays this local file once per lid-open session. Opening the lid does not send a model request. If the file is absent or the speaker is muted, the same greeting appears on screen and the microphone opens without local synthesized speech. Replace the file and `GREETING` text in `box/src/session/session.ts` together when changing the greeting.

// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/constants.ts.
import { CLIP_MAX_MS, CLIP_MIN_MS, CLIP_SAMPLE_RATE } from "@clara/contracts";

/**
 * The audio layer's timings and sizes in one place. "Placeholder" means chosen to behave sensibly in the
 * prototype, not measured on the box; replace after measuring.
 */

export { CLIP_MAX_MS, CLIP_MIN_MS, CLIP_SAMPLE_RATE };
/** 16 kHz mono 16-bit: 32 bytes per millisecond. */
export const CLIP_BYTES_PER_MS = (CLIP_SAMPLE_RATE * 2) / 1000;
export const CLIP_MAX_PCM_BYTES = CLIP_MAX_MS * CLIP_BYTES_PER_MS;

// ---- Voice-activity detection (docs/voice.md) ----

/** 0.7 s of silence ends a clip. */
export const VAD_END_SILENCE_MS = 700;
/** Placeholder: after a Talk press, the person has this long to start talking before the press ends empty. */
export const VAD_PRESS_NO_SPEECH_MS = 5_000;
/** Placeholder: a mic stream that died is opened again after this long. */
export const MIC_RESTART_MS = 2_000;

// ---- Playback ----

/** Placeholder: a line still playing after this is stopped and the queue moves on (a hung player). */
export const SPEECH_LINE_MAX_MS = 60_000;
/** Placeholder: a cue sound's player still running after this is killed. */
export const CUE_PLAYER_MAX_MS = 2_000;
/** A stopped player that ignores SIGTERM gets SIGKILL after this long. */
export const PLAYER_KILL_GRACE_MS = 2_000;

/**
 * The seams to the parts other people build: audio (box/src/audio), the voice loop (box/src/voice) and the
 * ESP32 board (box/src/hardware). Each is imported lazily and defensively: if a part fails to load or start,
 * this returns null, logs one line, and the box runs touch-only (no voice) or without lights and lid switch.
 *
 * TODO(wiring): check the option shapes below against the final audio/voice/hardware APIs; they were written
 * against the versions present when this file was made.
 */
import type { Action, TurnResponse } from "@clara/contracts";
import type { Board, CloudLink, CueName, Listener, Speaker, SpeechQueue } from "./ports.js";
import type { BoxSession, VoiceControl } from "./session/session.js";

type Log = (line: string) => void;

function logger(scope: string, log: Log) {
  return {
    info: (message: string) => log(`[${scope}] ${message}`),
    warn: (message: string) => log(`[${scope}] warn: ${message}`),
    error: (message: string) => log(`[${scope}] error: ${message}`),
  };
}

export interface AudioConfig {
  /** "pi" (arecord/aplay), "mac" (ffmpeg/afplay), or "silent" (print lines; no mic). */
  kind: "pi" | "mac" | "silent";
  micDevice?: string | undefined;
  speakerDevice?: string | undefined;
  piperModel?: string | undefined;
  /** WAV files to use as the mic (simulator). */
  micFiles?: string | undefined;
  print?: Log;
}

export interface AudioParts {
  speaker: Speaker;
  speech: SpeechQueue;
  /** Null when there is no microphone: the box is touch-only. */
  listener: Listener | null;
}

export async function loadAudio(config: AudioConfig, log: Log): Promise<AudioParts | null> {
  let audio: typeof import("./audio/index.js");
  try {
    audio = await import("./audio/index.js");
  } catch (error) {
    log(`audio not loaded (${(error as Error).message}); the box runs without sound`);
    return null;
  }
  try {
    const audioLog = logger("audio", log);
    const speaker =
      config.kind === "pi"
        ? audio.createSpeaker({ kind: "pi", device: config.speakerDevice ?? "default", piperModel: config.piperModel ?? null, log: audioLog })
        : config.kind === "mac"
          ? audio.createSpeaker({ kind: "mac" })
          : audio.createSpeaker({ kind: "silent", print: config.print ?? log });
    const speech = audio.createSpeechQueue(speaker, { log: audioLog, onError: (error) => log(`[speech] ${error.message}`) });
    let listener: Listener | null = null;
    try {
      const mic = config.micFiles
        ? audio.createMicrophone({ kind: "file", files: config.micFiles })
        : config.kind === "pi"
          ? audio.createMicrophone({ kind: "pi", device: config.micDevice ?? "default", log: audioLog })
          : config.kind === "mac"
            ? audio.createMicrophone({ kind: "mac", device: config.micDevice ?? "0", log: audioLog })
            : null;
      listener = mic ? audio.createListener(mic, { log: audioLog }) : null;
    } catch (error) {
      log(`microphone not started (${(error as Error).message}); touch only`);
    }
    return { speaker, speech, listener };
  } catch (error) {
    log(`audio not started (${(error as Error).message}); the box runs without sound`);
    return null;
  }
}

export async function loadBoard(o: { sim: boolean; log: Log }): Promise<Board | null> {
  try {
    const hardware = await import("./hardware/index.js");
    // keyboard: false: the simulator reads typed lines from stdin itself.
    return await hardware.openBoard({ sim: o.sim, keyboard: false, log: logger("board", o.log) });
  } catch (error) {
    o.log(`board not opened (${(error as Error).message}); no lights or lid switch (use the screen)`);
    return null;
  }
}

/**
 * The hands-free voice loop, adapted to the session's VoiceControl. The loop checks `actionAllowed` itself;
 * the session checks again before acting (applyAction).
 */
export async function loadVoiceLoop(o: {
  listener: Listener;
  speech: SpeechQueue;
  speaker: Speaker | null;
  cloud: CloudLink;
  session: BoxSession;
  log: Log;
}): Promise<(VoiceControl & { sendText?(text: string): Promise<void> }) | null> {
  try {
    const voice = await import("./voice/index.js");
    const { session } = o;
    const loop = voice.createVoiceLoop({
      listener: o.listener,
      queue: o.speech,
      voiceTurn: (request, signal) => o.cloud.voiceTurn(request, signal),
      getContext: () => {
        const state = session.turnState();
        const sessionId = session.sessionId;
        return state && sessionId ? { sessionId, language: session.language, state } : null;
      },
      onAction: (action: Action, response: TurnResponse) => {
        const accepted = session.applyAction(action, "voice", response);
        if (accepted && action.name === "select_step") session.remember("clara", response.reply);
        return accepted;
      },
      ...(o.speaker ? { playCue: (name: CueName) => o.speech.muted ? Promise.resolve() : o.speaker!.playCue(name) } : {}),
      onEvent: (event) => {
        if (event.type === "status") {
          session.setVoiceStatus(event.status);
          return;
        }
        if (event.type === "heard") {
          session.remember("person", event.heard);
          session.heard(event.heard, event.clientTurnId);
          return;
        }
        if (event.type !== "turn") return;
        if (event.action?.name !== "select_step") session.remember("clara", event.reply);
        if (event.action?.name !== "select_step" && event.reply) session.showCaption(event.reply, !event.action);
      },
      log: logger("voice", o.log),
    });
    return Object.assign(loop, { handsFree: o.listener.handsFree === true });
  } catch (error) {
    o.log(`voice loop not started (${(error as Error).message}); simulated SOS remains available`);
    return null;
  }
}

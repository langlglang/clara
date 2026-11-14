// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/run.ts and cli.ts: settings from the
// environment, every part optional except the scenario, and a clean shutdown on SIGINT/SIGTERM.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HttpCloudLink } from "./cloud/http.js";
import { Kit, loadKit } from "./engine/kit.js";
import { loadScenario } from "./engine/scenario.js";
import { UsbGpsLocation } from "./location/usb-gps.js";
import { CameraCapture, captureUsbJpeg, defaultCameraDevice } from "./camera/capture.js";
import { PulseReader } from "./sensors/pulse-reader.js";
import type { Board, CloudLink } from "./ports.js";
import { DEFAULT_SCREEN_PORT, startScreenServer, type ScreenServer } from "./screen/server.js";
import { BoxSession, type Need } from "./session/session.js";
import { loadAudio, loadBoard, loadVoiceLoop, type AudioConfig, type AudioParts } from "./wiring.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const REPO_ROOT = here("../../");
export const PUBLIC_DIR = here("../public/");

export interface BoxConfig {
  sim: boolean;
  /** Null in the simulator means "use the fake cloud". */
  serverUrl: string | null;
  boxId: string;
  boxName: string;
  directions: string | null;
  configuredAddress: string | null;
  gpsPort: string | null;
  token: string | null;
  scenarioPath: string | null;
  /** Scenarios the box may switch to (start-screen picker, "not breathing"). Missing files are skipped. */
  extraScenarioPaths: string[];
  kitPath: string | null;
  contentDir: string;
  stateDir: string;
  screenPort: number;
  language: string;
  need: Need | undefined;
  audio: AudioConfig["kind"];
  micDevice: string | undefined;
  speakerDevice: string | undefined;
  piperModel: string | undefined;
  micFiles: string | undefined;
  heartbeatMs: number;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
}

/** Settings from the environment (and a few flags), with demo defaults. */
export function readConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): BoxConfig {
  const sim = argv.includes("--sim");
  const audio = (env.CLARA_AUDIO as AudioConfig["kind"] | undefined) ?? (sim ? "silent" : process.platform === "linux" ? "pi" : process.platform === "darwin" ? "mac" : "silent");
  if (!["pi", "mac", "silent"].includes(audio)) throw new Error("CLARA_AUDIO must be pi, mac or silent.");
  const need = env.CLARA_NEED as Need | undefined;
  if (need && !["bleeding", "breathing", "general"].includes(need)) throw new Error("CLARA_NEED must be bleeding, breathing or general.");
  const port = Number(flag(argv, "port") ?? env.CLARA_SCREEN_PORT ?? DEFAULT_SCREEN_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("CLARA_SCREEN_PORT must be a port number.");
  return {
    sim,
    serverUrl: flag(argv, "server") ?? env.CLARA_SERVER_URL ?? (sim ? null : "https://clara.living"),
    boxId: env.CLARA_BOX_ID ?? (sim ? "box-sim" : "box-demo"),
    boxName: env.CLARA_BOX_NAME ?? (sim ? "Simulated box" : "Clara box"),
    directions: env.CLARA_BOX_DIRECTIONS ?? null,
    configuredAddress: env.CLARA_BOX_ADDRESS ?? null,
    gpsPort: sim ? null : env.CLARA_GPS_PORT ?? null,
    token: env.CLARA_BOX_TOKEN ?? null,
    scenarioPath: flag(argv, "scenario") ?? env.CLARA_SCENARIO ?? resolve(REPO_ROOT, "content/scenarios/severe-bleeding.json"),
    extraScenarioPaths: (env.CLARA_EXTRA_SCENARIOS ?? resolve(REPO_ROOT, "content/scenarios/not-breathing.json"))
      .split(",").map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== "none"),
    kitPath: flag(argv, "kit") ?? env.CLARA_KIT ?? resolve(REPO_ROOT, "content/kits/clara-3slot-v1.json"),
    contentDir: resolve(env.CLARA_CONTENT_DIR ?? resolve(REPO_ROOT, "content")),
    stateDir: resolve(env.CLARA_STATE_DIR ?? (sim ? ".box-state/sim" : ".box-state")),
    screenPort: port,
    language: env.CLARA_LANGUAGE ?? "en",
    need,
    audio,
    micDevice: env.CLARA_MIC_DEVICE,
    speakerDevice: env.CLARA_SPEAKER_DEVICE,
    piperModel: env.CLARA_PIPER_MODEL,
    micFiles: env.CLARA_MIC_FILES,
    heartbeatMs: Number(env.CLARA_HEARTBEAT_MS ?? 30_000),
  };
}

export interface RunningBox {
  session: BoxSession;
  cloud: CloudLink;
  board: Board | null;
  audio: AudioParts | null;
  screen: ScreenServer | null;
  location: UsbGpsLocation | null;
  stop(): Promise<void>;
}

/** Builds and starts every part. Only a missing or broken scenario stops the box from starting. */
export async function startBox(config: BoxConfig, o: { cloud?: CloudLink; board?: Board | null; log?: (line: string) => void; print?: (line: string) => void } = {}): Promise<RunningBox> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  if (!config.scenarioPath) throw new Error("Set CLARA_SCENARIO to a scenario file (content/scenarios/*.json).");
  const scenario = loadScenario(config.scenarioPath);
  let kit = Kit.empty();
  if (config.kitPath) kit = loadKit(config.kitPath);
  else log("no kit manifest (CLARA_KIT): no compartment will light");
  if (scenario.status !== "checked") log(`scenario ${scenario.scenario_id} is a DRAFT: not checked against its sources`);
  const extras = [];
  for (const path of config.extraScenarioPaths ?? []) {
    if (!existsSync(path)) continue;
    try {
      const extra = loadScenario(path);
      if (extra.status !== "checked") log(`scenario ${extra.scenario_id} is a DRAFT: not checked against its sources`);
      extras.push(extra);
    } catch (error) {
      log(`extra scenario ${path} not loaded: ${(error as Error).message}`);
    }
  }

  let cloud = o.cloud;
  let http: HttpCloudLink | null = null;
  if (!cloud) {
    if (!config.serverUrl) throw new Error("Set CLARA_SERVER_URL.");
    http = new HttpCloudLink({ serverUrl: config.serverUrl, boxId: config.boxId, token: config.token, stateDir: config.stateDir, log: (l) => log(`[cloud] ${l}`) });
    cloud = http;
  }
  const board = o.board !== undefined ? o.board : await loadBoard({ sim: config.sim, log });
  const location = config.gpsPort ? new UsbGpsLocation(config.gpsPort, (message) => log(`[gps] ${message}`)) : null;
  location?.start();
  const audio = await loadAudio(
    { kind: config.audio, micDevice: config.micDevice, speakerDevice: config.speakerDevice, piperModel: config.piperModel, micFiles: config.micFiles, print: o.print ?? log },
    log,
  );

  let session!: BoxSession;
  const cameraDevice = defaultCameraDevice();
  const camera = !config.sim && config.token && existsSync(cameraDevice)
    ? new CameraCapture(() => session?.sessionId ?? null, (signal) => captureUsbJpeg(cameraDevice, signal)) : null;
  const pulseReader = board && !board.simulated ? new PulseReader(board) : null;
  session = new BoxSession({
    boxId: config.boxId,
    boxName: config.boxName,
    directions: config.directions,
    configuredAddress: config.configuredAddress,
    location,
    scenario,
    scenarios: extras,
    kit,
    tick: !audio ? null
      : config.audio === "silent"
        ? (wav) => {
            log(`[audio] metronome segment ${(wav.length / 32_000).toFixed(1)} s`);
            return { done: Promise.resolve(), stop: () => {} };
          }
        : (wav) => audio.speaker.playWav(wav),
    cloud,
    board,
    pulseReader,
    camera,
    cameraCloudEnabled: Boolean(config.token),
    speech: audio?.speech ?? null,
    cue: audio ? (name) => { if (!audio.speech.muted) void audio.speaker.playCue(name).catch(() => {}); } : null,
    language: config.language,
    contentDir: config.contentDir,
    ...(config.need ? { need: config.need } : {}),
    simulated: config.sim || Boolean(board?.simulated) || Boolean(audio?.speaker.simulated),
    log,
  });

  const screen = await startScreenServer({
    port: config.screenPort,
    publicDir: PUBLIC_DIR,
    contentDir: existsSync(config.contentDir) ? config.contentDir : null,
    current: () => session.view(),
    onPress: (press) => session.press(press),
    log: (l) => log(`[screen] ${l}`),
  });
  if (screen) {
    session.onView((view) => screen.publish(view));
    log(`screen on ${screen.url}`);
  }

  if (audio?.listener) {
    session.attachVoice(await loadVoiceLoop({ listener: audio.listener, speech: audio.speech, speaker: audio.speaker, cloud, session, log }));
  }

  http?.start();
  session.startHeartbeat(config.heartbeatMs, () =>
    [board && !board.simulated ? "board" : null, audio ? "audio" : null, audio?.listener ? "mic" : null, screen ? "screen" : null].filter((p): p is string => p !== null),
  );
  log(`box ${config.boxId} ready (scenario ${scenario.scenario_id}, board: ${board?.label ?? "none"}, voice: ${audio?.listener?.handsFree ? "hands-free" : "unavailable"})`);

  let stopped = false;
  return {
    session,
    cloud,
    board,
    audio,
    screen,
    location,
    async stop() {
      if (stopped) return;
      stopped = true;
      session.close();
      await screen?.close();
      await board?.close().catch(() => {});
      await location?.close().catch(() => {});
      cloud.close();
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const config = readConfig(process.env, argv);
  if (config.sim) {
    const { runSim } = await import("./sim/simulate.js");
    return runSim(config);
  }
  const box = await startBox(config);
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await box.stop();
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/check/index.ts.
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { micCheck, speakerCheck, toneCheck } from "./audio.js";
import { boardCheck, portsCheck, realBoardSource, type BoardCheckOptions, type BoardSource } from "./board.js";
import { formatLine, runChecks, spawnRunner, summarize, type Check, type CheckContext, type CheckLine, type Runner } from "./core.js";

/**
 * `check`: the box's hardware self-test. Lists serial ports, opens the ESP32, pings it, reads the lid and
 * mount, and (when asked) blinks each LED channel, beeps, waits for a lid open/close and reads the pulse
 * sensor; then the microphone (1 s arecord, kept in memory) and speaker (aplay -L, and a tone with --sound).
 *
 *   npx tsx box/src/check/index.ts [--port PATH] [--sim] [--leds] [--beep] [--lid] [--pulse] [--sound] [--all]
 *
 * Stop the box service first (sudo systemctl stop clara-box): only one program can hold the serial port.
 * Exit code 1 when anything failed.
 */
export const USAGE = "Usage: check [--port PATH] [--sim] [--leds] [--beep] [--lid] [--pulse] [--sound] [--all] [--no-audio]";

export interface CheckArgs extends BoardCheckOptions {
  sound: boolean;
  audio: boolean;
}

export function parseArgs(argv: readonly string[]): CheckArgs | { error: string } {
  const args: CheckArgs = { port: undefined, sim: false, leds: false, beep: false, lid: false, pulse: false, sound: false, audio: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--port": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) return { error: "--port needs a path" };
        args.port = value;
        i += 1;
        break;
      }
      case "--sim": args.sim = true; break;
      case "--leds": args.leds = true; break;
      case "--beep": args.beep = true; break;
      case "--lid": args.lid = true; break;
      case "--pulse": args.pulse = true; break;
      case "--sound": args.sound = true; break;
      case "--no-audio": args.audio = false; break;
      case "--all": Object.assign(args, { leds: true, beep: true, lid: true, pulse: true, sound: true }); break;
      default: return { error: `unknown option ${arg}` };
    }
  }
  return args;
}

export interface CheckDeps {
  run: Runner;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  boards: BoardSource;
  write(line: string): void;
}

export function allChecks(args: CheckArgs, deps: CheckDeps, say: (line: string) => void): Check[] {
  const checks: Check[] = [];
  if (!args.sim) checks.push(portsCheck(deps.boards));
  checks.push(boardCheck(deps.boards, args, say));
  if (args.audio) checks.push(micCheck, speakerCheck, toneCheck(args.sound));
  return checks;
}

export async function boxCheck(args: CheckArgs, deps: CheckDeps): Promise<number> {
  const say = (line: string) => deps.write(`      >> ${line}`);
  const ctx: CheckContext = { run: deps.run, platform: deps.platform, env: deps.env, say };
  const started = performance.now();
  deps.write(`clara check on ${hostname()}, ${new Date().toISOString()}${args.sim ? " (simulated board)" : ""}.`);
  const lines: CheckLine[] = await runChecks(ctx, allChecks(args, deps, say), (line) => deps.write(formatLine(line)));
  const summary = summarize(lines, (performance.now() - started) / 1000);
  deps.write(summary.text);
  return summary.exitCode;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const code = await boxCheck(args, {
    run: spawnRunner,
    platform: process.platform,
    env: process.env,
    boards: realBoardSource,
    write: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

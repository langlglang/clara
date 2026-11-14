// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/process.ts.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** How the audio layer starts commands (arecord, aplay, piper, espeak-ng, ffmpeg, say, afplay). Injected in tests. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const realSpawn: SpawnFn = (command, args, options) => spawn(command, args, options);

/**
 * Signals a child only if it really started and hasn't exited. A child that failed to spawn has no pid, and
 * signalling it can reach this whole process group, which would stop the box service itself.
 */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

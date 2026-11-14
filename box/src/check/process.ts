// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/process.ts.
import type { ChildProcess } from "node:child_process";

/**
 * Signals a child only if it really started and hasn't exited. A child that failed to spawn (its command is
 * missing) has no pid, and signalling it could reach this whole process group.
 */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/check/core.ts.
import { spawn } from "node:child_process";
import { signalChild } from "./process.js";

/**
 * `check`: bring-up checks for the box. Each check takes a `CheckContext` (the commands it may run, the
 * options) and returns lines, so tests can run them against fake command output. Apart from the LED, buzzer and
 * tone tests the person asked for, nothing here changes anything.
 */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface CheckLine {
  status: CheckStatus;
  group: string;
  item: string;
  detail: string;
}

export interface RunResult {
  /** Exit code, or null when killed (timed out) or never started. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The command isn't installed (spawn ENOENT). */
  missing: boolean;
  timedOut: boolean;
  ms: number;
}

/** Runs one command with a time limit. `input` goes to its stdin. Never throws. */
export type Runner = (command: string, args: readonly string[], options?: { timeoutMs?: number; input?: string | Buffer }) => Promise<RunResult>;

export interface CheckContext {
  run: Runner;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Prompts for the person at the box (open the lid, put a finger on the sensor). */
  say(line: string): void;
}

export interface Check {
  name: string;
  /** The whole check's time limit; past it, one FAIL line and the run carries on. */
  timeoutMs: number;
  run(ctx: CheckContext): Promise<CheckLine[]>;
}

export const pass = (group: string, item: string, detail: string): CheckLine => ({ status: "PASS", group, item, detail });
export const warn = (group: string, item: string, detail: string): CheckLine => ({ status: "WARN", group, item, detail });
export const fail = (group: string, item: string, detail: string): CheckLine => ({ status: "FAIL", group, item, detail });
export const skip = (group: string, item: string, detail: string): CheckLine => ({ status: "SKIP", group, item, detail });

export const isLinux = (ctx: CheckContext) => ctx.platform === "linux";
export const NOT_A_PI = (ctx: CheckContext) => `not a Pi (${ctx.platform}); this runs on the box`;

/** Placeholder: how long one ordinary command may take. */
export const COMMAND_TIMEOUT_MS = 5000;
/** Most output kept from one command (a 1 s recording is 32,000 bytes). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const text = (result: RunResult) => result.stdout.toString("utf8");

/** Why a command didn't give an answer, in words; null when it exited 0. */
export function commandProblem(command: string, result: RunResult): string | null {
  if (result.missing) return `${command} is not installed`;
  if (result.timedOut) return `${command} gave no answer within ${Math.round(result.ms / 1000)} s`;
  if (result.code !== 0) {
    const said = result.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 160);
    return `${command} exited ${result.code ?? "on a signal"}${said ? `: ${said}` : ""}`;
  }
  return null;
}

/** The real runner: spawn, collect at most 1 MiB, kill (SIGKILL) at the time limit. */
export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = spawn(command, [...args], { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, missing: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, missing, timedOut, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild(child, "SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      chunks.push(data.subarray(0, MAX_OUTPUT_BYTES - bytes));
      bytes += Math.min(data.length, MAX_OUTPUT_BYTES - bytes);
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < 2000) stderr += data.toString();
    });
    // A command that can't start emits "error" and may never emit "close".
    child.once("error", (error) => finish(null, (error as NodeJS.ErrnoException).code === "ENOENT"));
    child.once("close", (code) => finish(timedOut ? null : code, false));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });

class DeadlineError extends Error {
  override name = "DeadlineError";
}

function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(`no answer within ${ms} ms`)), ms);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runs each check in order, printing its lines as they come, and returns every line. */
export async function runChecks(ctx: CheckContext, checks: readonly Check[], print: (line: CheckLine) => void): Promise<CheckLine[]> {
  const all: CheckLine[] = [];
  for (const check of checks) {
    let lines: CheckLine[];
    try {
      lines = await withDeadline(check.timeoutMs, () => check.run(ctx));
    } catch (error) {
      const message = error instanceof DeadlineError
        ? `no answer within ${Math.round(check.timeoutMs / 1000)} s`
        : `the check itself failed: ${error instanceof Error ? error.message : String(error)}`;
      lines = [fail(check.name, "check", message)];
    }
    for (const line of lines) {
      all.push(line);
      print(line);
    }
  }
  return all;
}

export function formatLine(line: CheckLine): string {
  return `${line.status.padEnd(4)}  ${line.group.padEnd(8)} ${line.item.padEnd(16)} ${line.detail}`;
}

export function summarize(lines: readonly CheckLine[], seconds: number): { text: string; exitCode: number } {
  const count = (status: CheckStatus) => lines.filter((line) => line.status === status).length;
  const failed = lines.filter((line) => line.status === "FAIL").map((line) => `${line.group} ${line.item}`);
  const warned = lines.filter((line) => line.status === "WARN").map((line) => `${line.group} ${line.item}`);
  const parts = [
    `Summary: ${count("PASS")} pass, ${count("WARN")} warn, ${count("FAIL")} fail, ${count("SKIP")} skip, in ${seconds.toFixed(1)} s.`,
    failed.length ? `Failed: ${failed.join(", ")}.` : "Nothing failed.",
    ...(warned.length ? [`Warnings: ${warned.join(", ")}.`] : []),
  ];
  return { text: parts.join("\n"), exitCode: failed.length ? 1 : 0 };
}

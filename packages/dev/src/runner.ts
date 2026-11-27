/**
 * Runs commands: spawns them without a shell, streams their output as
 * sanitised lines, runs chains step by step, and cancels by killing the whole
 * process tree (vitest workers, tsc) so nothing is left behind.
 */
import { spawn } from "node:child_process";
import { escapeForTerminal, redact } from "@cyberkit/core";
import { type CommandSpec, type FinalStatus, type LogLine, MAX_LINE_CHARS, type RunEvent, type Stream } from "./types.js";

export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export type Spawner = (argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProcess;
export type Killer = (child: SpawnedProcess, signal: NodeJS.Signals) => void;

export interface RunnerOptions {
  readonly resolve: (commandId: string) => CommandSpec | undefined;
  readonly onEvent: (event: RunEvent) => void;
  readonly spawner?: Spawner;
  readonly killer?: Killer;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly clock?: () => Date;
  readonly killGraceMs?: number;
}

export type ExitEvent = Extract<RunEvent, { type: "exit" }>;

export interface RunHandle {
  readonly runId: string;
  cancel(): void;
  readonly done: Promise<ExitEvent>;
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

function expandTabs(text: string): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(8 - ([...out].length % 8)) : ch;
  return out;
}

/** Makes one raw output line safe to show and store: see the design doc for the exact steps. */
export function sanitizeLine(raw: string, maxChars: number = MAX_LINE_CHARS): string {
  let text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const cr = text.lastIndexOf("\r");
  if (cr !== -1) text = text.slice(cr + 1);
  text = expandTabs(text.replace(ESCAPES, ""));
  text = escapeForTerminal(redact(text.slice(0, maxChars + 4096)));
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export const defaultSpawner: Spawner = (argv, { cwd, env }) =>
  spawn(argv[0] as string, argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });

export const defaultKiller: Killer = (child, signal) => {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, signal); // the whole process group (the child is its leader)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
};

export function labelFor(spec: CommandSpec): string {
  return spec.group === "root" || spec.group === "checks" || spec.group === "tools" ? spec.name : `${spec.group} › ${spec.name}`;
}

/** Splits a stream into lines, buffering a partial last line. */
function lineSplitter(stream: Stream, emit: (lines: LogLine[]) => void): { push(chunk: Buffer | string): void; end(): void } {
  let partial = "";
  return {
    push(chunk) {
      const parts = (partial + chunk.toString()).split("\n");
      partial = parts.pop() as string;
      if (parts.length > 0) emit(parts.map((p) => ({ stream, text: sanitizeLine(p) })));
    },
    end() {
      if (partial !== "") emit([{ stream, text: sanitizeLine(partial) }]);
      partial = "";
    },
  };
}

interface StepResult {
  readonly status: FinalStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export function startRun(spec: CommandSpec, runId: string, options: RunnerOptions): RunHandle {
  const spawner = options.spawner ?? defaultSpawner;
  const killer = options.killer ?? defaultKiller;
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? (() => new Date());
  const grace = options.killGraceMs ?? 2000;
  const env = { ...(options.env ?? process.env), FORCE_COLOR: "0", NO_COLOR: "1", CYBERKIT_DEV: "1" };
  const started = now();

  let cancelled = false;
  let current: { child: SpawnedProcess; closed: boolean } | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const emitLines = (lines: LogLine[]): void => options.onEvent({ type: "lines", runId, lines });
  const system = (text: string): void => emitLines([{ stream: "system", text: sanitizeLine(text) }]);

  const runStep = (step: CommandSpec): Promise<StepResult> =>
    new Promise((resolve) => {
      if (!step.argv || step.argv.length === 0) {
        system(`nothing to run for ${step.id}`);
        resolve({ status: "failed", exitCode: null, signal: null });
        return;
      }
      let settled = false;
      const settle = (r: StepResult): void => {
        if (settled) return;
        settled = true;
        if (current) current.closed = true;
        resolve(r);
      };
      let child: SpawnedProcess;
      try {
        child = spawner(step.argv, { cwd: step.cwd, env });
      } catch (e) {
        system(`failed to start: ${e instanceof Error ? e.message : String(e)}`);
        settle({ status: "failed", exitCode: null, signal: null });
        return;
      }
      current = { child, closed: false };
      const out = lineSplitter("stdout", emitLines);
      const err = lineSplitter("stderr", emitLines);
      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        system(`failed to start: ${e.message}`);
        settle({ status: "failed", exitCode: null, signal: null });
      });
      child.on("close", (code, signal) => {
        out.end();
        err.end();
        settle({ status: code === 0 && !signal ? "passed" : "failed", exitCode: code, signal });
      });
      if (cancelled) kill();
    });

  function kill(): void {
    const target = current;
    if (!target || target.closed) return;
    killer(target.child, "SIGTERM");
    killTimer = setTimeout(() => {
      if (!target.closed) killer(target.child, "SIGKILL");
    }, grace);
    killTimer.unref?.();
  }

  const done = (async (): Promise<ExitEvent> => {
    options.onEvent({ type: "start", runId, commandId: spec.id, label: labelFor(spec), startedAt: clock().toISOString() });
    let result: StepResult;
    if (spec.steps) {
      result = { status: "passed", exitCode: 0, signal: null };
      for (const id of spec.steps) {
        if (cancelled) break;
        const step = options.resolve(id);
        if (!step) {
          system(`unknown command ${id}`);
          result = { status: "failed", exitCode: null, signal: null };
          break;
        }
        system(`▶ ${labelFor(step)}: ${step.description}`);
        result = await runStep(step);
        if (result.status !== "passed") break;
      }
    } else {
      result = await runStep(spec);
    }
    if (killTimer) clearTimeout(killTimer);
    const exit: ExitEvent = {
      type: "exit",
      runId,
      status: cancelled ? "cancelled" : result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: Math.max(0, now() - started),
    };
    options.onEvent(exit);
    return exit;
  })();

  return {
    runId,
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      kill();
    },
  };
}

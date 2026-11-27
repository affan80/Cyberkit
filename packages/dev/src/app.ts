/**
 * The interactive shell around the pure state + view: owns the terminal
 * (alternate screen, raw mode, hidden cursor), batches runner output into one
 * state update per frame, runs and cancels commands, saves every run to the
 * cache, and always restores the terminal, whichever way the app ends.
 */
import { parseKeys } from "@cyberkit/tui";
import { type LogWriter, createLogWriter, readLog, saveRun, toHistoryEntry } from "./history.js";
import { type Killer, type RunHandle, type Spawner, startRun } from "./runner.js";
import { type Action, type DevState, update } from "./state.js";
import type { RunEvent } from "./types.js";
import { layout, render } from "./view.js";

export interface TerminalIn {
  readonly isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", fn: (chunk: string | Buffer) => void): unknown;
  off(event: "data", fn: (chunk: string | Buffer) => void): unknown;
}

export interface TerminalOut {
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): unknown;
  on(event: "resize", fn: () => void): unknown;
  off(event: "resize", fn: () => void): unknown;
}

export interface AppOptions {
  readonly state: DevState;
  readonly cacheDir: string;
  readonly color: boolean;
  /** Aborting ends the app (SIGTERM/SIGHUP); exit code 143. */
  readonly signal?: AbortSignal;
  readonly spawner?: Spawner;
  readonly killer?: Killer;
  readonly killGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

const ENTER = "\u001b[?1049h\u001b[?25l";
const LEAVE = "\u001b[?25h\u001b[?1049l";
const FRAME_MS = 16;
const SPIN_MS = 100;
export const EXIT_TERMINATED = 143;

let counter = 0;
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${++counter}`;
}

export function runApp(options: AppOptions, io: { stdin: TerminalIn; stdout: TerminalOut }): Promise<number> {
  const { stdin, stdout } = io;
  let state = options.state;
  let pending: RunEvent[] = [];
  let frameTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let quitting = false;
  let handle: RunHandle | undefined;
  /** Resolves once the current run has exited AND been saved to the cache. */
  let settled: Promise<void> = Promise.resolve();
  let writer: LogWriter | undefined;
  const grace = options.killGraceMs ?? 2000;

  return new Promise<number>((resolve, reject) => {
    const size = (): { cols: number; rows: number } => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    const dispatch = (action: Action): void => {
      state = update(state, action);
    };
    const draw = (): void => {
      if (finished) return;
      const { cols, rows } = size();
      dispatch({ type: "viewport", outputRows: layout(cols, rows).outputRows });
      stdout.write(`\u001b[H${render(state, { cols, rows, color: options.color }).split("\n").join("\r\n")}`);
    };
    const flush = (): void => {
      frameTimer = undefined;
      if (pending.length > 0) {
        const events = pending;
        pending = [];
        dispatch({ type: "run-events", events });
      }
      draw();
    };
    const schedule = (): void => {
      frameTimer ??= setTimeout(guard(flush), FRAME_MS);
    };

    const run = (commandId: string): void => {
      const spec = state.commands.find((c) => c.id === commandId);
      if (!spec || handle) return;
      const runId = newRunId();
      handle = startRun(spec, runId, {
        resolve: (id) => state.commands.find((c) => c.id === id),
        spawner: options.spawner,
        killer: options.killer,
        killGraceMs: grace,
        env: options.env,
        onEvent: (e) => {
          if (e.type === "start") writer = createLogWriter(options.cacheDir, runId, e.label);
          if (e.type === "lines") writer?.write(e.lines);
          pending.push(e);
          schedule();
        },
      });
      const h = handle;
      settled = h.done.then(async () => {
        const w = writer;
        writer = undefined;
        const logFile = w ? await w.close() : undefined;
        // Make sure the exit is in state, then save what the user saw (including extracted errors).
        if (pending.length > 0) {
          const events = pending;
          pending = [];
          dispatch({ type: "run-events", events });
        }
        if (logFile) dispatch({ type: "log-file", runId, logFile });
        const record = state.runs.find((r) => r.id === runId);
        if (record) await saveRun(options.cacheDir, { ...toHistoryEntry(record), ...(logFile ? { logFile } : {}) });
        if (handle === h) handle = undefined;
        if (!finished && !quitting) draw();
      });
      settled.catch(() => undefined);
    };

    const loadLog = (runId: string): void => {
      const record = state.runs.find((r) => r.id === runId);
      if (!record?.logFile) {
        dispatch({ type: "log-loaded", runId, lines: [] });
        draw();
        return;
      }
      void readLog(record.logFile).then((lines) => {
        if (finished) return;
        dispatch({ type: "log-loaded", runId, lines });
        draw();
      });
    };

    /** Cancels the running command and waits for it (bounded), then restores the terminal. */
    const shutdown = (code: number): void => {
      if (quitting) return;
      quitting = true;
      const h = handle;
      if (!h) return finish(code);
      h.cancel();
      // Wait for the child to die and the run to be saved, but never hang on it.
      const timeout = new Promise<void>((r) => setTimeout(r, grace + 1000).unref?.());
      void Promise.race([settled.catch(() => undefined), timeout]).then(() => finish(code));
    };

    const onData = (chunk: string | Buffer): void => {
      for (const key of parseKeys(chunk.toString())) {
        dispatch({ type: "key", key });
        const command = state.command;
        if (!command) continue;
        dispatch({ type: "command-done" });
        if (command.type === "quit") return shutdown(0);
        if (command.type === "run") run(command.commandId);
        if (command.type === "cancel") handle?.cancel();
        if (command.type === "load-log") loadLog(command.runId);
      }
      draw();
    };
    const onKeys = (chunk: string | Buffer): void => guard(onData)(chunk);
    const onResize = (): void => guard(draw)();
    const onAbort = (): void => shutdown(EXIT_TERMINATED);
    const spinner = setInterval(
      () =>
        guard(() => {
          if (state.activeRunId) {
            dispatch({ type: "tick" });
            draw();
          }
        })(),
      SPIN_MS,
    );

    function finish(code: number, error?: unknown): void {
      if (finished) return;
      finished = true;
      clearInterval(spinner);
      if (frameTimer) clearTimeout(frameTimer);
      handle?.cancel();
      stdin.off("data", onKeys);
      stdout.off("resize", onResize);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        stdin.setRawMode?.(false);
        stdin.pause();
      } finally {
        stdout.write(LEAVE);
      }
      if (error === undefined) resolve(code);
      else reject(error);
    }

    // Any unexpected exception still restores the terminal (and cancels the child) before surfacing.
    function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
      return (...args: A) => {
        try {
          fn(...args);
        } catch (e) {
          finish(1, e);
        }
      };
    }

    stdout.write(ENTER);
    stdin.setRawMode?.(true);
    stdin.setEncoding?.("utf8");
    stdin.on("data", onKeys);
    stdin.resume();
    stdout.on("resize", onResize);
    if (options.signal?.aborted) return finish(EXIT_TERMINATED);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    guard(draw)();
  });
}

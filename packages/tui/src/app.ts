/**
 * The interactive shell around the pure state + view: owns the terminal
 * (alternate screen, raw mode, cursor), streams a scan into the state in
 * per-frame batches, handles keys, resize, rescan and export, and always
 * restores the terminal, whichever way the app ends.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EXIT,
  type FailOn,
  type PluginSpec,
  type ScanEvent,
  escapeForTerminal,
  exitCodeForError,
  redact,
  renderJson,
  scanStream,
} from "@cyberkit/core";
import { parseKeys } from "./keys.js";
import { type Action, type TuiState, initialState, update, visibleFindings } from "./state.js";
import { render } from "./view.js";

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
  readonly target: string;
  readonly plugins: readonly PluginSpec[];
  readonly failOn: FailOn;
  readonly color: boolean;
  /** Directory that exports are written to. */
  readonly cwd: string;
  readonly now?: () => Date;
  /** Aborting ends the app (used for SIGTERM/SIGHUP); exit code 143. */
  readonly signal?: AbortSignal;
}

const ENTER = "\u001b[?1049h\u001b[?25l";
const LEAVE = "\u001b[?25h\u001b[?1049l";
const FRAME_MS = 16;
const SPIN_MS = 100;
export const EXIT_INTERRUPTED = 130;
export const EXIT_TERMINATED = 143;

const pluginLabel = (p: PluginSpec): string =>
  typeof p === "string" ? p : "module" in p ? path.basename(p.module).replace(/\.[cm]?js$/, "") : p.name;

export function runApp(options: AppOptions, io: { stdin: TerminalIn; stdout: TerminalOut }): Promise<number> {
  const { stdin, stdout } = io;
  const now = options.now ?? (() => new Date());
  let state: TuiState = initialState(options.target, options.plugins.map(pluginLabel));
  let generation = 0;
  let pending: ScanEvent[] = [];
  let frameTimer: NodeJS.Timeout | undefined;
  let scanErrorCode: number = EXIT.SCAN_ERROR;
  let finished = false;

  return new Promise<number>((resolve, reject) => {
    const draw = (): void => {
      const frame = render(state, { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24, color: options.color });
      stdout.write(`\u001b[H${frame.split("\n").join("\r\n")}`);
    };
    const dispatch = (action: Action): void => {
      state = update(state, action);
    };
    const flush = (): void => {
      frameTimer = undefined;
      if (pending.length > 0) {
        dispatch({ type: "scan-events", events: pending });
        pending = [];
      }
      draw();
    };
    const schedule = (): void => {
      frameTimer ??= setTimeout(guard(flush), FRAME_MS);
    };

    const startScan = (): void => {
      const gen = ++generation;
      void (async () => {
        try {
          for await (const event of scanStream({ target: options.target, plugins: options.plugins, failOn: options.failOn })) {
            if (gen !== generation || finished) return;
            pending.push(event);
            schedule();
          }
        } catch (e) {
          if (gen !== generation || finished) return;
          scanErrorCode = exitCodeForError(e);
          pending = [];
          dispatch({ type: "scan-error", message: escapeForTerminal(redact(e instanceof Error ? e.message : String(e))) });
          schedule();
        }
      })();
    };

    const exportReport = async (): Promise<void> => {
      const name = `cyberkit-report-${now().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}.json`;
      const shown = visibleFindings(state);
      try {
        // "wx" = O_CREAT | O_EXCL: never overwrites an existing file and never follows a symlink.
        await writeFile(path.join(options.cwd, name), renderJson(shown, { pretty: true }), { flag: "wx" });
        dispatch({ type: "notice", text: `Exported ${shown.length} finding${shown.length === 1 ? "" : "s"} to ${name}` });
      } catch (e) {
        dispatch({ type: "notice", text: `Export failed: ${escapeForTerminal(e instanceof Error ? e.message : String(e))}` });
      }
      if (!finished) draw();
    };

    const exitCode = (): number => (state.phase === "done" ? (state.exitCode ?? EXIT.OK) : state.phase === "error" ? scanErrorCode : EXIT_INTERRUPTED);

    const onData = (chunk: string | Buffer): void => {
      if (pending.length > 0) {
        dispatch({ type: "scan-events", events: pending });
        pending = [];
      }
      for (const key of parseKeys(chunk.toString())) {
        dispatch({ type: "key", key });
        const command = state.command;
        if (command) dispatch({ type: "command-done" });
        if (command === "quit") return finish(exitCode());
        if (command === "rescan") {
          dispatch({ type: "restart" });
          startScan();
        }
        if (command === "export") void exportReport();
      }
      draw();
    };
    const onKeys = (chunk: string | Buffer): void => guard(onData)(chunk);
    const onResize = (): void => guard(draw)();
    const onAbort = (): void => finish(EXIT_TERMINATED);
    const spinner = setInterval(
      () =>
        guard(() => {
          if (state.phase === "scanning") {
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

    // Any unexpected exception still restores the terminal before surfacing.
    function guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
      return (...args: A) => {
        try {
          fn(...args);
        } catch (e) {
          finish(EXIT.SCAN_ERROR, e);
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
    startScan();
  });
}

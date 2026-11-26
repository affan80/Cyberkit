/** `cyberkit-tui` entrypoint: argument parsing, terminal checks and the --frame snapshot mode. */
import { parseArgs } from "node:util";
import {
  ConfigError,
  EXIT,
  type FailOn,
  VERSION,
  createConfig,
  escapeForTerminal,
  exitCodeForError,
  planScan,
  redact,
  scanStream,
  type ScanEvent,
} from "@cyberkit/core";
import { type TerminalIn, type TerminalOut, runApp } from "./app.js";
import { parseKeys } from "./keys.js";
import { initialState, update } from "./state.js";
import { render } from "./view.js";

export const HELP_TEXT = `Usage: cyberkit-tui [target] [options]

Interactive, lazygit-style view of a CyberKit scan. Findings stream in live.

Options:
  -p, --plugin <name>   Enable a plugin (repeatable). Built in: semgrep
      --fail-on <sev>   Severity that sets exit code 1 (default: low)
      --frame           Don't go interactive: scan, then print one frame and exit
      --cols <n>        Frame width for --frame (default: terminal width or 100)
      --rows <n>        Frame height for --frame (default: terminal height or 30)
      --keys <keys>     Keystrokes to replay before drawing the --frame
  -h, --help            Show this help
  -v, --version         Show the version

Keys: j/k move · tab/1-4 panes · / search · s severity · esc clear · r rescan
      e export · ? help · q quit (exit code = the scan's exit code)
`;

export interface TuiCliIO {
  readonly stdin: TerminalIn;
  readonly stdout: TerminalOut & { readonly isTTY?: boolean };
  readonly stderr: { write(chunk: string): unknown };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

const OPTIONS = {
  plugin: { type: "string", short: "p", multiple: true },
  "fail-on": { type: "string" },
  frame: { type: "boolean" },
  cols: { type: "string" },
  rows: { type: "string" },
  keys: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const describe = (e: unknown): string => escapeForTerminal(redact(e instanceof Error ? e.message : String(e)));

function size(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ConfigError(`--${name} must be an integer between 1 and 1000`);
  return n;
}

/** NO_COLOR (no-color.org) always wins; FORCE_COLOR forces colour; otherwise colour only on a TTY. */
function useColor(io: TuiCliIO): boolean {
  if (io.env.NO_COLOR) return false;
  if (io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== "0") return true;
  return io.stdout.isTTY === true;
}

async function frame(target: string, plugins: readonly string[], failOn: FailOn, cols: number, rows: number, keys: string, io: TuiCliIO): Promise<number> {
  const events: ScanEvent[] = [];
  let state = initialState(target, plugins);
  let code: number;
  try {
    for await (const e of scanStream({ target, plugins, failOn })) events.push(e);
    state = update(state, { type: "scan-events", events });
    code = state.exitCode ?? EXIT.OK;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    state = update(update(state, { type: "scan-events", events }), { type: "scan-error", message: describe(e) });
    code = exitCodeForError(e);
  }
  for (const key of parseKeys(keys)) state = update(update(state, { type: "key", key }), { type: "command-done" });
  io.stdout.write(`${render(state, { cols, rows, color: useColor(io) })}\n`);
  return code;
}

export async function main(argv: readonly string[], io: TuiCliIO): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new ConfigError(e instanceof Error ? e.message : "invalid arguments");
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.stdout.write(HELP_TEXT);
      return EXIT.OK;
    }
    if (values.version) {
      io.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (positionals.length > 1) throw new ConfigError("expected at most one target");
    // Reuse the core config validation so the TUI accepts exactly what the CLI accepts.
    const config = createConfig({ target: positionals[0], plugins: values.plugin, failOn: values["fail-on"] });
    const cols = size(values.cols, io.stdout.columns ?? 100, "cols");
    const rows = size(values.rows, io.stdout.rows ?? 30, "rows");

    if (values.frame) return await frame(config.target, config.plugins, config.failOn, cols, rows, values.keys ?? "", io);

    if (!io.stdin.isTTY || !io.stdout.isTTY) {
      io.stderr.write("cyberkit-tui: needs an interactive terminal (use --frame to print a single frame instead)\n");
      return EXIT.USAGE;
    }
    // Fail fast on unknown plugins before taking over the screen.
    try {
      await planScan({ target: config.target, plugins: config.plugins, failOn: config.failOn });
    } catch (e) {
      if (e instanceof ConfigError) throw e; // scope errors are shown inside the TUI instead
    }
    const ac = new AbortController();
    const stop = (): void => ac.abort();
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      return await runApp(
        { target: config.target, plugins: config.plugins, failOn: config.failOn, color: useColor(io), cwd: io.cwd, signal: ac.signal },
        { stdin: io.stdin, stdout: io.stdout },
      );
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  } catch (e) {
    io.stderr.write(`cyberkit-tui: ${describe(e)}\n`);
    if (e instanceof ConfigError) {
      io.stderr.write('Run "cyberkit-tui --help" for usage.\n');
      return EXIT.USAGE;
    }
    return exitCodeForError(e);
  }
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
  process.exitCode = await main(argv, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
}

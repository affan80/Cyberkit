/** `cyberkit-dev` entrypoint: the interactive console, plus non-interactive modes for scripts and tests. */
import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION, escapeForTerminal, redact } from "@cyberkit/core";
import { parseKeys } from "@cyberkit/tui";
import { EXIT_TERMINATED, type TerminalIn, type TerminalOut, newRunId, runApp } from "./app.js";
import { discoverCommands, findRepoRoot } from "./commands.js";
import { extractErrors, formatError } from "./errors.js";
import { clearHistory, createLogWriter, defaultCacheDir, fromHistoryEntry, loadHistory, readLog, saveRun, toHistoryEntry } from "./history.js";
import { type Spawner, labelFor, startRun } from "./runner.js";
import { initialState, update } from "./state.js";
import type { CommandSpec, LogLine, RunRecord } from "./types.js";
import { formatDuration, layout, render } from "./view.js";

export const HELP_TEXT = `Usage: cyberkit-dev [options]

Lazygit-style console for working on this repo: run every npm script, the
checks chain and a repo scan from one place, keep a history of runs and see
the errors of each run.

Modes:
      --list            Print the commands it can run, then exit
      --run <id>        Run one command (e.g. root:test, chain:verify) without the UI,
                        print its error log, exit with its exit code
      --errors [run]    Print the error log of the latest run (or the given run id)
      --history         Print the recent runs
      --clear-history   Delete the run cache
      --frame           Print one frame of the console (with --cols, --rows, --keys) and exit

Options:
      --cwd <dir>       Where to look for the repo (default: the current directory)
      --cache-dir <dir> Where runs are cached (default: node_modules/.cache/cyberkit-dev)
      --cols <n>        Frame width for --frame (default: terminal width or 100)
      --rows <n>        Frame height for --frame (default: terminal height or 30)
      --keys <keys>     Keystrokes to replay before drawing the --frame (commands don't run)
  -h, --help            Show this help
  -v, --version         Show the version

Keys: enter run · a run all checks · r rerun · x cancel · e errors only · / filter
      tab/1-4 panes · j/k move · ? help · q quit
`;

export interface DevCliIO {
  readonly stdin: TerminalIn;
  readonly stdout: TerminalOut & { readonly isTTY?: boolean };
  readonly stderr: { write(chunk: string): unknown };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** For tests: replaces child_process.spawn. */
  readonly spawner?: Spawner;
}

const OPTIONS = {
  list: { type: "boolean" },
  run: { type: "string" },
  errors: { type: "boolean" },
  history: { type: "boolean" },
  "clear-history": { type: "boolean" },
  frame: { type: "boolean" },
  cwd: { type: "string" },
  "cache-dir": { type: "string" },
  cols: { type: "string" },
  rows: { type: "string" },
  keys: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

class UsageError extends Error {}
const EXIT_USAGE = 2;
const describe = (e: unknown): string => escapeForTerminal(redact(e instanceof Error ? e.message : String(e)));

function size(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UsageError(`--${name} must be an integer between 1 and 1000`);
  return n;
}

function useColor(io: DevCliIO): boolean {
  if (io.env.NO_COLOR) return false;
  if (io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== "0") return true;
  return io.stdout.isTTY === true;
}

const ICON: Readonly<Record<string, string>> = { passed: "✓", failed: "✗", cancelled: "⊘", running: "…" };

function printErrors(io: DevCliIO, label: string, errors: RunRecord["errors"]): void {
  io.stdout.write(`── error log: ${label} (${errors.length}) ──\n`);
  for (const e of errors) io.stdout.write(`${escapeForTerminal(formatError(e))}\n`);
}

async function runOnce(commands: readonly CommandSpec[], id: string, cacheDir: string, io: DevCliIO): Promise<number> {
  const spec = commands.find((c) => c.id === id);
  if (!spec) throw new UsageError(`unknown command "${id}" (see --list)`);
  const runId = newRunId();
  const writer = createLogWriter(cacheDir, runId, labelFor(spec));
  const lines: LogLine[] = [];
  const handle = startRun(spec, runId, {
    resolve: (cid) => commands.find((c) => c.id === cid),
    spawner: io.spawner,
    onEvent: (e) => {
      if (e.type !== "lines") return;
      writer.write(e.lines);
      for (const l of e.lines) {
        lines.push(l);
        (l.stream === "stderr" ? io.stderr : io.stdout).write(`${l.stream === "system" ? "» " : ""}${l.text}\n`);
      }
    },
  });
  const cancel = (): void => handle.cancel();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let exit;
  try {
    exit = await handle.done;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  const logFile = await writer.close();
  const errors = extractErrors(lines, { exitCode: exit.status === "passed" ? 0 : (exit.exitCode ?? 1) });
  const record: RunRecord = { id: runId, commandId: spec.id, label: labelFor(spec), status: exit.status, startedAt: new Date().toISOString(), durationMs: exit.durationMs, exitCode: exit.exitCode, signal: exit.signal, lines: [], droppedLines: 0, errors, logFile };
  await saveRun(cacheDir, toHistoryEntry(record));
  io.stdout.write("\n");
  printErrors(io, record.label, errors);
  io.stdout.write(`${ICON[exit.status]} ${record.label} ${exit.status} in ${formatDuration(exit.durationMs)} · log: ${logFile}\n`);
  if (exit.status === "cancelled") return 130;
  return exit.status === "passed" ? 0 : exit.exitCode !== null && exit.exitCode !== 0 ? exit.exitCode : 1;
}

export async function main(argv: readonly string[], io: DevCliIO): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : "invalid arguments");
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.stdout.write(HELP_TEXT);
      return 0;
    }
    if (values.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (positionals.length > (values.errors ? 1 : 0)) throw new UsageError(`unexpected argument "${positionals[0]}"`);

    const root = await findRepoRoot(path.resolve(io.cwd, values.cwd ?? "."));
    const cacheDir = values["cache-dir"] ? path.resolve(io.cwd, values["cache-dir"]) : defaultCacheDir(root);

    if (values["clear-history"]) {
      await clearHistory(cacheDir);
      io.stdout.write(`cleared ${cacheDir}\n`);
      return 0;
    }
    if (values.history || values.errors) {
      const history = await loadHistory(cacheDir);
      if (values.history) {
        if (history.length === 0) io.stdout.write("no runs yet\n");
        for (const h of history) io.stdout.write(`${ICON[h.status]} ${h.startedAt.replace("T", " ").slice(0, 19)}  ${escapeForTerminal(h.label)}  ${formatDuration(h.durationMs)}  ${h.errorCount} error${h.errorCount === 1 ? "" : "s"}  ${h.id}\n`);
        return 0;
      }
      const wanted = positionals[0];
      const h = wanted ? history.find((r) => r.id === wanted) : history[0];
      if (!h) {
        io.stderr.write(`cyberkit-dev: ${wanted ? `no run "${escapeForTerminal(wanted)}" in the history` : "no runs in the history yet"}\n`);
        return EXIT_USAGE;
      }
      printErrors(io, `${escapeForTerminal(h.label)} · ${h.status} · ${h.startedAt}`, h.errors);
      if (h.errorCount > h.errors.length) io.stdout.write(`… ${h.errorCount - h.errors.length} more in ${h.logFile ?? "the log"}\n`);
      return 0;
    }

    const commands = await discoverCommands(root);
    if (values.list) {
      let group = "";
      for (const c of commands) {
        if (c.group !== group) io.stdout.write(`${group ? "\n" : ""}${(group = c.group)}\n`);
        io.stdout.write(`  ${c.id.padEnd(24)} ${escapeForTerminal(c.description)}\n`);
      }
      return 0;
    }
    if (values.run !== undefined) return await runOnce(commands, values.run, cacheDir, io);

    let state = update(initialState(path.basename(root), commands), { type: "history", runs: (await loadHistory(cacheDir)).map(fromHistoryEntry) });
    if (values.frame) {
      const cols = size(values.cols, io.stdout.columns ?? 100, "cols");
      const rows = size(values.rows, io.stdout.rows ?? 30, "rows");
      state = update(state, { type: "viewport", outputRows: layout(cols, rows).outputRows });
      // Replay keys through the reducer only: commands are never executed in frame mode.
      for (const key of parseKeys(values.keys ?? "")) {
        state = update(state, { type: "key", key });
        const command = state.command;
        state = update(state, { type: "command-done" });
        // Reading a cached log is safe (it runs nothing), so frame mode does it; "run" commands are ignored.
        if (command?.type === "load-log") {
          const run = state.runs.find((r) => r.id === command.runId);
          state = update(state, { type: "log-loaded", runId: command.runId, lines: run?.logFile ? await readLog(run.logFile) : [] });
        }
      }
      io.stdout.write(`${render(state, { cols, rows, color: useColor(io) })}\n`);
      return 0;
    }

    if (!io.stdin.isTTY || !io.stdout.isTTY) {
      io.stderr.write("cyberkit-dev: needs an interactive terminal (try --list, --run <id> or --frame)\n");
      return EXIT_USAGE;
    }
    const ac = new AbortController();
    const stop = (): void => ac.abort();
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      return await runApp({ state, cacheDir, color: useColor(io), signal: ac.signal, spawner: io.spawner }, { stdin: io.stdin, stdout: io.stdout });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  } catch (e) {
    io.stderr.write(`cyberkit-dev: ${describe(e)}\n`);
    if (e instanceof UsageError) {
      io.stderr.write('Run "cyberkit-dev --help" for usage.\n');
      return EXIT_USAGE;
    }
    return 1;
  }
}

export { EXIT_TERMINATED };

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (!["EPIPE", "ENOTCONN", "ECONNRESET"].includes(e.code ?? "")) throw e;
  });
  process.exitCode = await main(argv, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
}

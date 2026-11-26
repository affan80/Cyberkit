# Developer console (`cyberkit-dev`) design

## Intent

The maintainer wants one command, typed like `lazygit`, that opens a lazygit-style terminal console for working on the CyberKit repo:
- run every project command (build, lint, typecheck, tests per package, test report, bench, scan) from one place and watch the output live;
- keep ("cache") every run, so earlier runs and their output can be revisited, including after a restart, like lazygit's command log;
- an **error log**: the errors from each run pulled out of the noise (TypeScript, ESLint, failing tests, exceptions, npm errors), each one jumpable.

**Goals:** fast keyboard-driven workflow; nothing to configure (commands are discovered from `package.json`); safe output handling (a security tool must not leak secrets into logs or let command output inject terminal escapes).

**Non-goals:** a general task runner or CI replacement; running commands in parallel; editing files; shipping to end users (the package is private, for repo development only).

**Anti-goals:** a console that hangs or leaves the terminal broken; orphaned child processes (vitest workers, tsc) after cancel/quit; secrets from command output persisted to disk; output that can move the cursor or rewrite the screen.

## Approach

A new private workspace package `packages/dev` (`@cyberkit/dev`, bin `cyberkit-dev`, root script `npm run ui`), built like `@cyberkit/tui`: a pure reducer (`state.ts`) and a pure renderer (`view.ts`), a thin interactive shell (`app.ts`) that owns the terminal, and side-effect modules for discovery (`commands.ts`), processes (`runner.ts`), errors (`errors.ts`) and persistence (`history.ts`). It reuses `parseKeys` from `@cyberkit/tui` and `redact` / `escapeForTerminal` from `@cyberkit/core`.

Alternatives considered: adding a "dev mode" to `@cyberkit/tui` (rejected: that package ships to users, the console is repo-only); a generic script runner like a shell script with `fzf` (rejected: no history, no error extraction, not cross-platform).

## Layout

```
 CyberKit dev console · cyberkit                         ⠹ running core › test  12.3s
┌ 1 Commands ───────────────────┐┌ 3 Output · core › test · running · 1,204 lines ─ follow ┐
│ checks                         ││ > @cyberkit/core@0.1.0 test                              │
│ ▶ verify             ✓ 1m02s   ││ > vitest run                                             │
│ root                           ││  ✓ test/finding.test.ts (38 tests) 12ms                  │
│   build              ✓ 8.1s    ││  × test/store.test.ts > reads (3 tests | 1 failed)       │
│   lint               ✗ 3.2s    ││ ...                                                      │
│   test                         ││                                                          │
│ core                           ││                                                          │
│   test               ⠹         │├ 4 Errors (2) · lint ─────────────────────────────────────┤
├ 2 Runs ────────────────────────┤│ eslint  packages/bench/src/run.mjs:91:62  'URL' is not de│
│ ⠹ 04:05:12 core › test   12.3s ││ ts      src/a.ts:3:5  TS2322 Type 'string' is not assign │
│ ✗ 04:04:50 lint   3.2s  2 err  ││                                                          │
│ ✓ 04:03:10 build  8.1s         ││                                                          │
└────────────────────────────────┘└──────────────────────────────────────────────────────────┘
 enter run · a run all checks · r rerun · x cancel · e errors only · / filter · ? help · q quit
```

- Line 1: title (repo directory name) and, right-aligned, the status: spinner + label + elapsed while running, otherwise `idle · N runs`.
- Left column (≈ 36% of the width, at least 30 columns): **1 Commands** on top, **2 Runs** below (≈ 40% of the body height).
- Right column: **3 Output** on top (≈ 65%), **4 Errors** below.
- Last line: key hints for the focused pane (or the search prompt / confirm prompt).
- The focused pane's border and title are highlighted (bold green), like lazygit.
- Every line is exactly `cols` cells and there are exactly `rows` lines (one code point = one cell, as in `@cyberkit/tui`). Below `MIN_COLS = 70` × `MIN_ROWS = 18`, render a centred "Terminal too small (need 70×18)" message instead.

Status icons: `✓` passed (green), `✗` failed (red), spinner frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` for running (yellow), `⊘` cancelled (dim). Durations: `850ms`, `8.1s`, `1m02s`.

## Keys

| Key | Action |
|---|---|
| `j`/`k`, `↓`/`↑` | Move the selection (lists) or scroll by one line (output) |
| `g`/`G`, `home`/`end` | Top / bottom. In Output, `G`/`end` turns follow back on |
| `ctrl-d`/`ctrl-u`, `pagedown`/`pageup` | Half a page down / up |
| `tab`/`shift-tab` | Next / previous pane; `1`–`4` jump to a pane |
| `h`/`l`, `←`/`→` | Left column / right column |
| `enter` or `space` | Commands: run the selected command. Runs: show that run in Output and Errors (loads its log if it came from history). Errors: jump the output to that error (turns follow off) |
| `a` | Run all checks (the `chain:verify` command) |
| `r` | Re-run the command of the run shown in Output (or the selected command if there is none) |
| `x` | Cancel the running command |
| `e` | Toggle "errors only" in Output: show only the lines that errors point at, plus 3 lines of context after each |
| `f` | Toggle follow (auto-scroll) in Output |
| `/` | Filter the Output lines (case-insensitive substring). Typing edits the query, `enter` keeps it, `esc` clears it |
| `esc` | Clear the filter and errors-only mode, close help |
| `?` | Help overlay listing all keys; any key closes it |
| `q`, `ctrl-c` | Quit. If a command is running, ask "A command is running. Quit and cancel it? (y/n)" first |

Only one command runs at a time. Starting another while one runs shows the notice "core › test is still running (x to cancel)". Starting a run makes it the shown run, turns follow on and focuses nothing new (focus stays where it is).

## Module contracts

Types live in `packages/dev/src/types.ts` (already written; do not change it without updating this doc). All modules are ESM TypeScript (`NodeNext`, imports end in `.js`), strict, no `any`.

### `commands.ts`: discovery
```ts
export function findRepoRoot(start: string): Promise<string>;
export function discoverCommands(root: string, options?: { platform?: NodeJS.Platform; execPath?: string }): Promise<CommandSpec[]>;
export function npmArgv(script: string, platform?: NodeJS.Platform): string[];
export const SCRIPT_NAME: RegExp; // /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
```
- `findRepoRoot`: walks up from `start` to the nearest directory whose `package.json` has a `workspaces` field; else the nearest directory with a `package.json`; else `start`.
- Order of the result: group `checks` (the chain), then `root`, then each workspace in directory order, then `tools`.
- **root**: every script in the root `package.json`, except lifecycle hooks: `preX`/`postX` when `X` is also a script, and `prepare`, `prepublishOnly`, `preinstall`, `install`, `postinstall`. Id `root:<script>`, group `root`, cwd = root, `argv = npmArgv(script)`.
- **workspaces**: `workspaces` entries may be literal dirs or end in `/*` (read the directory, sorted by name, keep sub-directories with a `package.json`). Group = the package name after the last `/` (`@cyberkit/core` → `core`), or the directory name if unnamed. Id `<group>:<script>`, cwd = the workspace dir. Same hook filtering.
- Script names that don't match `SCRIPT_NAME` are skipped (they would need quoting on Windows).
- `npmArgv(s)`: POSIX `["npm", "run", s]`; win32 `["cmd.exe", "/d", "/s", "/c", "npm", "run", s]`.
- **checks**: `chain:verify`, name `verify`, description e.g. `lint → typecheck → build → test`, `steps` = those of `root:lint`, `root:typecheck`, `root:build`, `root:test` that exist (CI order). Omitted if none exist.
- **tools**: if `<root>/packages/core/bin/cyberkit` exists: `tool:scan`, name `scan this repo`, `argv = [execPath, <that bin>, "scan", "."]` (execPath defaults to `process.execPath`), cwd = root.
- A missing or invalid `package.json` in a workspace is skipped, never fatal. An invalid root `package.json` throws an `Error` with a clear message.

### `runner.ts`: processes
```ts
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
  readonly resolve: (commandId: string) => CommandSpec | undefined; // for chain steps
  readonly onEvent: (event: RunEvent) => void;
  readonly spawner?: Spawner; // default: defaultSpawner
  readonly killer?: Killer;   // default: defaultKiller
  readonly env?: NodeJS.ProcessEnv; // default: process.env
  readonly now?: () => number; // ms clock, default performance.now
  readonly clock?: () => Date; // wall clock for startedAt, default new Date()
  readonly killGraceMs?: number; // default 2000
}
export interface RunHandle {
  readonly runId: string;
  cancel(): void;
  readonly done: Promise<Extract<RunEvent, { type: "exit" }>>;
}
export function startRun(spec: CommandSpec, runId: string, options: RunnerOptions): RunHandle;
export function sanitizeLine(raw: string, maxChars?: number): string;
export const defaultSpawner: Spawner;
export const defaultKiller: Killer;
export function labelFor(spec: CommandSpec): string; // "core › test", "verify", "scan this repo"
```
- Emits `start` once, then `lines` batches (one per data chunk, possibly several lines), then exactly one `exit`. `startedAt` is the clock's ISO string.
- Child env: `{ ...env, FORCE_COLOR: "0", NO_COLOR: "1", CYBERKIT_DEV: "1" }`.
- `defaultSpawner`: `child_process.spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true })`. `detached` makes the child a process-group leader so cancel can kill the whole tree.
- `defaultKiller`: POSIX `process.kill(-pid, signal)` (whole group), falling back to killing just the pid; win32 `spawn("taskkill", ["/pid", String(pid), "/T", "/F"])`. Errors (e.g. already exited) are swallowed.
- Lines: stdout and stderr are split independently on `\n`; a partial last line is buffered until more data arrives or the stream ends (then flushed). A `\r\n` ending counts as `\n`. Every line goes through `sanitizeLine`.
- `sanitizeLine(raw, maxChars = MAX_LINE_CHARS)`, in this order:
  1. carriage-return progress: keep only the text after the last `\r` (after removing one trailing `\r`);
  2. strip escape sequences: CSI `ESC [ … final`, OSC `ESC ] … (BEL | ESC \)`, other 2-byte `ESC X`, and 8-bit CSI `\x9b … final`;
  3. expand tabs to spaces (tab stops every 8 columns);
  4. cut to `maxChars + 4096` characters, then `redact()` (so a secret straddling the final cut is still caught whole);
  5. `escapeForTerminal()` for any remaining control characters;
  6. cut to `maxChars` characters, appending `…` if anything was cut.
- Chains: run the steps in order; before each step emit a `system` line `▶ <step label>: <step description>`; stop at the first step that does not pass. The chain's exit status/code is the failing step's (or `passed`, code 0). A step id that doesn't resolve: system line `unknown command <id>`, status `failed`, code null.
- Exit status: code 0 → `passed`; non-zero code or a signal → `failed`; after `cancel()` → `cancelled` regardless. A spawn `error` event (e.g. ENOENT) → system line `failed to start: <message>` (sanitised), status `failed`, code null.
- `cancel()`: kill with SIGTERM via the killer; if the process hasn't closed after `killGraceMs`, kill with SIGKILL. For a chain, cancels the current step and runs no further steps. Idempotent; a no-op after exit.
- Exactly one `exit` event even if both `error` and `close` fire.

### `errors.ts`: the error log
```ts
export function extractErrors(lines: readonly LogLine[], options?: { exitCode?: number | null; maxErrors?: number }): ErrorEntry[];
export function formatError(e: ErrorEntry): string; // one line: "<kind>  <file>:<line>:<col>  <rule> <message>" without empty parts
```
Recognisers, applied line by line in one pass (linear time; no regex with nested quantifiers):
- **typescript**: `^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$` → file, line, col, rule = code, message. Also `^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$` (tsc --pretty false variant).
- **eslint** (stylish formatter): a line that is a file path (starts with `/` or a drive letter, no leading spaces) sets the current file; following lines `^\s+(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)\s*$` → eslint entry with that file, line, col, message, rule. Warnings are ignored.
- **test** (vitest): `^\s*FAIL\s+(\S+)\s+>\s+(.+)$` → file, test = the `>`-separated names joined with ` > `; the message is the first following line within 15 lines that matches `^\s*(\w*Error|AssertionError)\b.*` (trimmed), else "test failed"; the location is the first following ` ❯ <file>:<line>:<col>` line within 15 lines. Only `FAIL` lines create entries, never the `×` summary lines, so each failure is counted once.
- **exception**: `^\s*(?:Uncaught )?([A-Z]\w*Error): (.+)$` not already consumed by a test entry → message; location from the first following `^\s+at .*?\(?(\S+?):(\d+):(\d+)\)?$` line within 5 lines (skip `node:` internals).
- **npm**: `^npm (?:error|ERR!) (.+)$` → only the line containing `Lifecycle script` or `command failed` or `code E…`, one entry per run (keep the most specific, e.g. "Lifecycle script `test` failed with error").
- **generic** fallback: if `exitCode` is non-zero (or null after a failure) and nothing else was found, one entry with the last non-empty stderr line (else the last non-empty line), `lineIndex` pointing at it.
- Deduplicate entries with the same kind + file + line + col + message. Keep source order. Cap at `maxErrors` (default 200).

### `history.ts`: the run cache
```ts
export function defaultCacheDir(root: string): string; // <root>/node_modules/.cache/cyberkit-dev
export function loadHistory(cacheDir: string): Promise<HistoryEntry[]>; // newest first; [] if missing or corrupt
export function saveRun(cacheDir: string, entry: HistoryEntry): Promise<void>; // prepend, keep MAX_HISTORY_RUNS, delete log files of dropped runs
export interface LogWriter { write(lines: readonly LogLine[]): void; close(): Promise<string>; } // close resolves to the log path
export function createLogWriter(cacheDir: string, runId: string, label: string): LogWriter;
export function readLog(file: string, maxLines?: number): Promise<LogLine[]>; // last maxLines (default MAX_MEMORY_LINES)
export function toHistoryEntry(run: RunRecord): HistoryEntry;
export function fromHistoryEntry(entry: HistoryEntry): RunRecord; // fromHistory: true, lines: []
export function clearHistory(cacheDir: string): Promise<void>;
```
- Layout: `<cacheDir>/history.json` (`{ "version": 1, "runs": HistoryEntry[] }`) and `<cacheDir>/logs/<runId>.log`.
- Log format: one line per `LogLine`, `stderr` lines prefixed with `! `, `system` lines with `# `, stdout lines with two spaces; `readLog` parses that back. A header line `# <label> · started <iso>` first.
- Writes are append-only and buffered (flush at least every 64 KB or on close). The log stops at `MAX_LOG_BYTES` with a final `# log truncated at 10 MB` line.
- Safety: create the cache dir with `recursive: true`; create log files with flag `wx` (O_EXCL, never follows a symlink, never overwrites) and mode `0o600`; write `history.json` via a temp file in the same dir + `rename`. Lines are already redacted by the runner; `saveRun` and the writer redact again anyway (defence in depth, `redact` is idempotent).
- Persistence must never crash the console: every function catches I/O errors; `loadHistory` returns `[]`, the writer becomes a no-op, `saveRun` resolves.

### `state.ts`: the reducer
```ts
export type Pane = "commands" | "runs" | "output" | "errors";
export const PANES: readonly Pane[];
export type DevCommand =
  | { readonly type: "run"; readonly commandId: string }
  | { readonly type: "cancel" }
  | { readonly type: "quit" }
  | { readonly type: "load-log"; readonly runId: string };
export interface DevState {
  readonly repo: string;              // display name of the repo
  readonly commands: readonly CommandSpec[];
  readonly runs: readonly RunRecord[]; // newest first
  readonly activeRunId?: string;       // the running run, if any
  readonly viewRunId?: string;         // the run shown in Output/Errors
  readonly focus: Pane;
  readonly selected: Readonly<Record<Pane, number>>; // commands/runs/errors: list index; output: unused
  readonly follow: boolean;
  readonly outputTop: number;          // first visible output line (of the filtered list) when not following
  readonly outputRows: number;         // viewport height of the Output pane, set by the app via "viewport"
  readonly errorsOnly: boolean;
  readonly query: string;
  readonly mode: "normal" | "search" | "help" | "confirm-quit";
  readonly notice?: string;
  readonly spinner: number;
  readonly command?: DevCommand;       // side effect requested by the last key; the app consumes it
}
export type Action =
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "run-events"; readonly events: readonly RunEvent[] }
  | { readonly type: "history"; readonly runs: readonly RunRecord[] }
  | { readonly type: "log-loaded"; readonly runId: string; readonly lines: readonly LogLine[]; readonly logFile?: string }
  | { readonly type: "viewport"; readonly outputRows: number }
  | { readonly type: "tick" }
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "command-done" };
export function initialState(repo: string, commands: readonly CommandSpec[]): DevState;
export function update(state: DevState, action: Action): DevState;
export function outputLines(state: DevState): { readonly lines: readonly LogLine[]; readonly indexes: readonly number[] }; // after errors-only + filter; indexes map back to run.lines
export function viewRun(state: DevState): RunRecord | undefined;
export function lastRunOf(state: DevState, commandId: string): RunRecord | undefined;
export const KEY_HELP: ReadonlyArray<readonly [keys: string, action: string]>;
```
- Pure and immutable. `initialState`: focus `commands`, selection 0, follow on, mode normal.
- `run-events`: `start` prepends a running `RunRecord` (lines [], droppedLines 0, errors []), sets `activeRunId` and `viewRunId`, follow on; `lines` appends to that run, trimming the front to `MAX_MEMORY_LINES` and counting `droppedLines` (appending must be amortised O(batch), not O(total): build the new array with one `concat`/`slice`); `exit` sets status/exitCode/signal/durationMs, clears `activeRunId`, and computes `errors = extractErrors(lines, { exitCode })`. Note that `errors[i].lineIndex` is relative to the current `lines` array.
- `history`: appends restored runs after any live runs (no duplicates by id).
- `log-loaded`: fills that run's `lines` (and errors via `extractErrors` if it has none) and clears `fromHistory`.
- Keys follow the Keys table. Pressing `enter` on a Runs entry with `fromHistory` sets `command: { type: "load-log" }`. `enter` on Commands emits `command: { type: "run", commandId }`, or a notice if one is running. `a` = run `chain:verify` (notice "no checks found" if absent). `q`/`ctrl-c` with a running command → `confirm-quit` mode; `y` → `command: quit`; anything else back to normal.
- Scrolling in Output: when follow is on and the user scrolls up, follow turns off and `outputTop` starts at `max(0, len - outputRows)`; scrolling to the bottom or `G` turns follow back on. `outputTop` is always clamped to `[0, max(0, len - outputRows)]`.
- Errors `enter`: set follow off, clear the filter, and set `outputTop` so that the error's line is the first visible line (in errors-only mode, map through `indexes`).
- Selection indexes are clamped to the list lengths after every action (lists can shrink).

### `view.ts`: the renderer
```ts
export interface RenderOptions { readonly cols: number; readonly rows: number; readonly color: boolean; readonly now?: number }
export const MIN_COLS = 70;
export const MIN_ROWS = 18;
export function render(state: DevState, options: RenderOptions): string; // rows lines joined by "\n", each exactly cols cells
export function layout(cols: number, rows: number): { readonly outputRows: number; /* plus pane rectangles */ };
export function formatDuration(ms: number): string;
```
- Pure. Uses the layout and icons above. Lists scroll to keep the selection visible. The help overlay is a centred box listing `KEY_HELP`. The confirm-quit and search prompts replace the footer.
- Defensive: escape every dynamic string with `escapeForTerminal` (cheap, and lines are already sanitised) so no state can inject escapes.
- `layout()` is what the app uses to tell the reducer `outputRows`.

### `app.ts` and `cli.ts`: the shell
- `runApp(options, io)`, modelled on `packages/tui/src/app.ts`: alternate screen + hidden cursor, raw mode, draw by moving home and writing the frame, `\r\n` line endings, a 16 ms frame timer that batches runner events into one `run-events` action per frame, a 100 ms spinner tick while running, resize redraws, and a `guard` that restores the terminal on any exception. It consumes `state.command`: `run` (start the runner with a new run id; open a `LogWriter`; on exit close it and `saveRun`), `cancel`, `load-log` (`readLog` → `log-loaded`), `quit`. On quit or abort (SIGTERM/SIGHUP via `options.signal`), cancel the running command and wait for it (at most `killGraceMs` + 500 ms) before restoring the terminal. Exit code 0 on quit, 143 on abort.
- `cli.ts`: `cyberkit-dev [options]`
  - `--list`: print the discovered commands grouped, `id  description`, and exit 0.
  - `--run <id>`: run one command non-interactively; stream its sanitised lines to stdout; then print the error log (`formatError` per entry) and a summary line; save it to history; exit with the command's exit code (1 if it failed without one, 130 if cancelled by SIGINT/SIGTERM).
  - `--errors [run-id]`: print the error log of the latest run in history (or the given run) and exit 0 (2 if there is no such run).
  - `--history`: print recent runs (status icon, time, label, duration, error count) and exit 0.
  - `--clear-history`: delete the cache and exit 0.
  - `--frame [--cols n --rows n --keys k]`: render a single frame (history loaded, keys replayed through the reducer, commands NOT executed) and exit 0. For tests and screenshots.
  - `--cwd <dir>`: start directory for `findRepoRoot` (default: process cwd). `--cache-dir <dir>`: override the cache location.
  - `-h/--help`, `-v/--version`.
  - With no mode flag it needs a TTY on stdin and stdout; otherwise print "cyberkit-dev: needs an interactive terminal (try --list, --run <id> or --frame)" and exit 2.
  - Colour: `NO_COLOR` wins, then `FORCE_COLOR`, else only on a TTY (same rule as `cyberkit-tui`).
- `index.ts` re-exports the public pieces.
- Root `package.json`: `"ui": "cyberkit-dev"`.

## Testing

TDD per module with vitest (files under `packages/dev/test/`, importing `../src/*.js`). Required coverage:
- commands: discovery against temp-dir fixture repos (root scripts, `packages/*` workspaces, literal workspaces, hook filtering, invalid names, missing/invalid package.json, chain composition, tool detection, win32 argv).
- runner: real child processes via `process.execPath -e` (partial lines across chunks, stderr vs stdout, ANSI/CR/tab sanitising, redaction, exit codes, spawn failure, chains stopping at the first failure, cancel killing a process tree that ignores SIGTERM within the grace period, exactly one exit event).
- errors: real output samples (tsc, eslint stylish, vitest FAIL blocks with ❯ locations, uncaught exceptions with stacks, npm lifecycle errors), dedupe, generic fallback, linear time on 200k lines.
- history: round trip, cap + pruning of old logs, corrupt history.json, truncation at the byte cap, `wx` refusing a pre-planted symlink, redaction on write, I/O failures never throwing.
- state: every key in the table, follow/scroll clamping, errors jump in both modes, filter, confirm-quit, history merge, log loading, selection clamping, O(batch) appends.
- view: exact dimensions for several sizes, too-small message, icons/colours on and off, escaping of hostile strings, help overlay, prompts.
- app/cli: a fake terminal (like `packages/tui/test/app.test.ts`), terminal restored on quit/abort/exception, run + cancel through keys with real child processes, `--list`, `--run` (exit codes and error log), `--errors`, `--history`, `--frame` snapshots, non-TTY refusal.

## What's left to the builder

Exact colours beyond the ones named, wording of notices, and internal helper structure, as long as the contracts above hold.

## Changes made during implementation

- `errors.extractErrors` skips npm's `> script` / `> command` echo lines and the console's own `system` lines when recognising errors (both can quote error-looking text, which produced duplicate entries in real runs). The generic fallback still sees them.
- Scripts whose command is `cyberkit-dev` (e.g. the root `ui` script) are not listed: the console can't run itself.
- The reducer has one more action, `log-file`, so the app can record a run's log path after the log is closed.
- `--frame` performs `load-log` (reading a cached log is safe), so a frame can show a cached run's output and error log; `run` commands are still never executed in frame mode.
- On quit with a running command, the app waits for the cancelled run to be saved to the cache (bounded by the kill grace period + 1 s) before restoring the terminal.

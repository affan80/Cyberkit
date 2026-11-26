/**
 * Shared data model for the developer console. Every module codes against
 * these types; see docs/superpowers/specs/2026-11-27-dev-console-design.md.
 */

/** Where a log line came from. "system" lines are written by the console itself (step headers, exit notes). */
export type Stream = "stdout" | "stderr" | "system";

/**
 * One line of command output, already sanitised (see runner.sanitizeLine):
 * ANSI sequences stripped, carriage-return progress collapsed, tabs expanded,
 * secrets redacted, remaining control characters escaped, length capped.
 * Safe to write to a terminal or a file as is.
 */
export interface LogLine {
  readonly stream: Stream;
  readonly text: string;
}

/** Something the console can run: an npm script, a chain of other commands, or a built-in tool. */
export interface CommandSpec {
  /** Stable and unique, e.g. "root:test", "core:build", "chain:verify", "tool:scan". */
  readonly id: string;
  /** Display group, e.g. "checks", "root", "core", "tui", "bench", "tools". */
  readonly group: string;
  /** Display name, e.g. "test" or "verify". */
  readonly name: string;
  /** What it runs, shown to the user, e.g. the npm script body or "lint → typecheck → build → test". */
  readonly description: string;
  /** Program and arguments, spawned WITHOUT a shell. Absent for chains. */
  readonly argv?: readonly string[];
  /** Absolute working directory. */
  readonly cwd: string;
  /** For chains: ids of the commands to run in order, stopping at the first failure. */
  readonly steps?: readonly string[];
}

export type RunStatus = "running" | "passed" | "failed" | "cancelled";
export type FinalStatus = Exclude<RunStatus, "running">;

export type ErrorKind = "typescript" | "eslint" | "test" | "exception" | "npm" | "generic";

/** One error extracted from a run's output (see errors.extractErrors). */
export interface ErrorEntry {
  readonly kind: ErrorKind;
  /** One-line summary, e.g. "AssertionError: expected 6 to be 7". */
  readonly message: string;
  /** Path as printed by the tool (relative or absolute). */
  readonly file?: string;
  readonly line?: number;
  readonly col?: number;
  /** ESLint rule id or TypeScript error code ("TS2322"). */
  readonly rule?: string;
  /** For test failures: "suite > test name". */
  readonly test?: string;
  /** Index into the run's `lines` where the error starts, so the UI can jump to it. */
  readonly lineIndex: number;
}

/** A run of one command, live or from history. */
export interface RunRecord {
  /** Unique, sortable: "<yyyymmddThhmmss>-<n>", e.g. "20261127T040512-3". */
  readonly id: string;
  readonly commandId: string;
  /** Display label, e.g. "core › test". */
  readonly label: string;
  readonly status: RunStatus;
  /** ISO timestamp. */
  readonly startedAt: string;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** In-memory output, capped at MAX_MEMORY_LINES (oldest dropped first). Empty for history entries until their log is loaded. */
  readonly lines: readonly LogLine[];
  /** Lines dropped from the front because of the in-memory cap. */
  readonly droppedLines: number;
  /** Extracted when the run ends (and when a history log is loaded). */
  readonly errors: readonly ErrorEntry[];
  /** Absolute path of the persisted, redacted log, if any. */
  readonly logFile?: string;
  /** True for runs restored from history whose log has not been loaded yet. */
  readonly fromHistory?: boolean;
}

/** Events the runner emits while a command runs. */
export type RunEvent =
  | { readonly type: "start"; readonly runId: string; readonly commandId: string; readonly label: string; readonly startedAt: string }
  | { readonly type: "lines"; readonly runId: string; readonly lines: readonly LogLine[] }
  | {
      readonly type: "exit";
      readonly runId: string;
      readonly status: FinalStatus;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly durationMs: number;
    };

/** What history.json stores per run (no output lines; those live in the log file). */
export interface HistoryEntry {
  readonly id: string;
  readonly commandId: string;
  readonly label: string;
  readonly status: FinalStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly errorCount: number;
  /** At most MAX_HISTORY_ERRORS. */
  readonly errors: readonly ErrorEntry[];
  readonly logFile?: string;
}

/** Limits shared by the modules. */
export const MAX_LINE_CHARS = 2000;
export const MAX_MEMORY_LINES = 20_000;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_HISTORY_RUNS = 100;
export const MAX_HISTORY_ERRORS = 50;

/**
 * Stable exit codes for CI. These values are part of the public contract:
 * never renumber them, only append new ones.
 */
import { SEVERITIES, type Finding, type Severity } from "../finding.js";
import type { PluginRunResult } from "../plugins/base.js";
import { ConfigError, type FailOn } from "./config.js";

export const EXIT = Object.freeze({
  /** No findings at or above the threshold. */
  OK: 0,
  /** At least one finding at or above the threshold. */
  FINDINGS: 1,
  /** Bad arguments or configuration. */
  USAGE: 2,
  /** The scan could not run or finish (invalid target, I/O, corrupt store, ...). */
  SCAN_ERROR: 3,
  /** The scan finished but a plugin failed, and nothing crossed the threshold. */
  PARTIAL: 4,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const rank = (s: Severity): number => SEVERITIES.indexOf(s);

export function meetsThreshold(severity: Severity, failOn: FailOn): boolean {
  return failOn !== "none" && rank(severity) >= rank(failOn);
}

export interface ScanOutcome {
  readonly findings: readonly Finding[];
  readonly failOn: FailOn;
  readonly plugins?: readonly Pick<PluginRunResult, "status">[];
}

/** Exit code for a scan that ran. A confirmed finding outranks a partial run. */
export function exitCodeFor(outcome: ScanOutcome): ExitCode {
  if (outcome.findings.some((f) => meetsThreshold(f.severity, outcome.failOn))) return EXIT.FINDINGS;
  if (outcome.plugins?.some((p) => p.status !== "ok")) return EXIT.PARTIAL;
  return EXIT.OK;
}

/** Exit code for a scan that threw before producing an outcome. */
export function exitCodeForError(error: unknown): ExitCode {
  return error instanceof ConfigError ? EXIT.USAGE : EXIT.SCAN_ERROR;
}

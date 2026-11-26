/** Shared, total ordering for findings so every reporter is deterministic. */
import { type Finding, SEVERITIES, type Severity } from "../finding.js";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

/**
 * Ordinal (UTF-16 code unit) string order. Unlike localeCompare() it doesn't
 * depend on the runtime's locale or ICU data, so identical findings give
 * byte-identical reports on every machine, and it is ~8x faster (#60).
 */
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Severity (highest first), then file, line, rule and finally id. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    ordinal(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    ordinal(a.ruleId, b.ruleId) ||
    ordinal(a.id, b.id)
  );
}

/** Returns a sorted copy; the input is never mutated. */
export const sortFindings = (findings: readonly Finding[]): Finding[] => [...findings].sort(compareFindings);

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  return counts;
}

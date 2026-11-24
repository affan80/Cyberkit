/** Shared, total ordering for findings so every reporter is deterministic. */
import { type Finding, SEVERITIES, type Severity } from "../finding.js";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

/** Severity (highest first), then file, line, rule and finally id. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.ruleId.localeCompare(b.ruleId) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Returns a sorted copy; the input is never mutated. */
export const sortFindings = (findings: readonly Finding[]): Finding[] => [...findings].sort(compareFindings);

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  return counts;
}

import { type Finding, type Severity, createFinding } from "@cyberkit/core";

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

let n = 0;
export function finding(over: Partial<{ severity: Severity; ruleId: string; message: string; file: string; line: number; engine: string; evidence: string }> = {}): Finding {
  n++;
  return createFinding({ engine: "supply-chain", ruleId: "wildcard-version", severity: "medium", message: `finding ${n}`, file: "package.json", line: n, ...over });
}

/**
 * Plain text reporter for humans. Pure: findings in, string out.
 * Output is deterministic (sorted by severity, file, line, rule, id) and
 * every untrusted string is escaped, so a finding cannot inject terminal
 * escape sequences, Trojan-Source bidi controls, or fake extra lines.
 */
import { type Finding, SEVERITIES, type Severity } from "../finding.js";
import { countBySeverity, sortFindings } from "./order.js";

export interface PlainOptions {
  /** Colour severity labels with ANSI codes. The CLI enables this for TTYs. */
  readonly color?: boolean;
}

const LABEL_WIDTH = 10;
const INDENT = " ".repeat(LABEL_WIDTH);
const COLOR: Readonly<Record<Severity, string>> = {
  critical: "\u001b[1;35m",
  high: "\u001b[31m",
  medium: "\u001b[33m",
  low: "\u001b[36m",
  info: "\u001b[2m",
};
const RESET = "\u001b[0m";

// C0/C1 controls, DEL, and bidi embedding/override/isolate characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const NAMED: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function escapeForTerminal(text: string): string {
  return text.replace(UNSAFE, (c) => {
    const code = c.charCodeAt(0);
    return NAMED[c] ?? (code > 0xff ? `\\u{${code.toString(16)}}` : `\\x${code.toString(16).padStart(2, "0")}`);
  });
}

function summary(findings: readonly Finding[]): string {
  const counts = countBySeverity(findings);
  const parts = [...SEVERITIES].reverse().flatMap((s) => (counts[s] > 0 ? [`${counts[s]} ${s}`] : []));
  const noun = findings.length === 1 ? "finding" : "findings";
  return `CyberKit: ${findings.length} ${noun} (${parts.join(", ")})`;
}

export function renderPlain(findings: readonly Finding[], options: PlainOptions = {}): string {
  if (findings.length === 0) return "CyberKit: no findings\n";

  const blocks = sortFindings(findings).map((f) => {
    const label = f.severity.toUpperCase();
    const padded = label.padEnd(LABEL_WIDTH);
    const head = options.color ? `${COLOR[f.severity]}${label}${RESET}${padded.slice(label.length)}` : padded;
    const where = f.file === undefined ? "(project)" : `${escapeForTerminal(f.file)}${f.line === undefined ? "" : `:${f.line}`}`;
    return `${head}${where}  ${escapeForTerminal(f.engine)}/${escapeForTerminal(f.ruleId)}\n${INDENT}${escapeForTerminal(f.message)}\n`;
  });

  return `${summary(findings)}\n\n${blocks.join("\n")}`;
}

/** Machine-readable JSON report. Versioned so consumers can detect format changes. */
import type { Finding } from "../finding.js";
import { VERSION } from "../version.js";
import { countBySeverity, sortFindings } from "./order.js";

export const JSON_SCHEMA_VERSION = 1;

export interface JsonOptions {
  readonly pretty?: boolean;
}

export function renderJson(findings: readonly Finding[], options: JsonOptions = {}): string {
  const doc = {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: "cyberkit", version: VERSION },
    summary: { total: findings.length, bySeverity: countBySeverity(findings) },
    findings: sortFindings(findings),
  };
  return `${JSON.stringify(doc, null, options.pretty ? 2 : undefined)}\n`;
}

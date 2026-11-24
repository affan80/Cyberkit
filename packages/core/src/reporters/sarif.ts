/**
 * SARIF 2.1.0 report for GitHub code scanning and IDEs.
 * Rule ids are `engine/ruleId`; the content-addressed finding id is used as a
 * partial fingerprint, so alerts stay stable across runs.
 */
import type { Finding, Severity } from "../finding.js";
import { VERSION } from "../version.js";
import { SEVERITY_RANK, sortFindings } from "./order.js";

type Level = "error" | "warning" | "note";

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const LEVEL: Readonly<Record<Severity, Level>> = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };
// GitHub buckets security-severity: >=9 critical, 7-8.9 high, 4-6.9 medium, 0.1-3.9 low.
const SECURITY_SEVERITY: Readonly<Record<Severity, string>> = { critical: "9.5", high: "8.0", medium: "5.5", low: "2.0", info: "0.0" };

const ruleKey = (f: Finding): string => `${f.engine}/${f.ruleId}`;
const toUri = (file: string): string => file.split("/").map(encodeURIComponent).join("/");

export function renderSarif(findings: readonly Finding[]): string {
  const sorted = sortFindings(findings);

  // One rule per engine/ruleId, carrying the highest severity seen.
  const maxSeverity = new Map<string, Severity>();
  for (const f of sorted) {
    const key = ruleKey(f);
    const seen = maxSeverity.get(key);
    if (seen === undefined || SEVERITY_RANK[f.severity] > SEVERITY_RANK[seen]) maxSeverity.set(key, f.severity);
  }
  const ruleIds = [...maxSeverity.keys()].sort();
  const ruleIndex = new Map(ruleIds.map((id, i) => [id, i]));
  const rules = ruleIds.map((id) => {
    const severity = maxSeverity.get(id) as Severity;
    return {
      id,
      shortDescription: { text: id.slice(id.indexOf("/") + 1) },
      defaultConfiguration: { level: LEVEL[severity] },
      properties: { tags: ["security"], "security-severity": SECURITY_SEVERITY[severity] },
    };
  });

  const results = sorted.map((f) => {
    const id = ruleKey(f);
    return {
      ruleId: id,
      ruleIndex: ruleIndex.get(id) as number,
      level: LEVEL[f.severity],
      message: { text: f.message },
      ...(f.file === undefined
        ? {}
        : {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: toUri(f.file), uriBaseId: "%SRCROOT%" },
                  ...(f.line === undefined ? {} : { region: { startLine: f.line } }),
                },
              },
            ],
          }),
      partialFingerprints: { "cyberkitFindingId/v1": f.id },
    };
  });

  const log = {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "CyberKit", version: VERSION, rules } }, results, columnKind: "utf16CodeUnits" }],
  };
  return `${JSON.stringify(log)}\n`;
}

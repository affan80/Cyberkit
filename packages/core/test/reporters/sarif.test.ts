import { describe, expect, it } from "vitest";
import { createFinding, type FindingInput } from "../../src/finding.js";
import { renderSarif } from "../../src/reporters/sarif.js";
import { VERSION } from "../../src/version.js";

const f = (over: Partial<FindingInput> = {}) =>
  createFinding({ engine: "supply-chain", ruleId: "wildcard-version", severity: "medium", message: "left@* accepts any version", file: "package.json", line: 5, ...over });

type Sarif = {
  version: string;
  $schema: string;
  runs: {
    tool: { driver: { name: string; version: string; rules: { id: string; shortDescription: { text: string }; defaultConfiguration: { level: string }; properties: Record<string, unknown> }[] } };
    results: { ruleId: string; ruleIndex: number; level: string; message: { text: string }; locations?: { physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region?: { startLine: number } } }[]; partialFingerprints: Record<string, string> }[];
    columnKind: string;
  }[];
};
const parse = (s: string) => JSON.parse(s) as Sarif;

describe("renderSarif", () => {
  it("produces a SARIF 2.1.0 log with one run", () => {
    const log = parse(renderSarif([f()]));
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toMatch(/sarif-2\.1\.0/);
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]?.tool.driver).toMatchObject({ name: "CyberKit", version: VERSION });
  });

  it("maps a finding to a result with location, line and stable fingerprint", () => {
    const finding = f();
    const [r] = parse(renderSarif([finding])).runs[0]!.results;
    expect(r).toEqual({
      ruleId: "supply-chain/wildcard-version",
      ruleIndex: 0,
      level: "warning",
      message: { text: "left@* accepts any version" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "package.json", uriBaseId: "%SRCROOT%" }, region: { startLine: 5 } } }],
      partialFingerprints: { "cyberkitFindingId/v1": finding.id },
    });
  });

  it.each([
    ["critical", "error", "9.5"],
    ["high", "error", "8.0"],
    ["medium", "warning", "5.5"],
    ["low", "note", "2.0"],
    ["info", "note", "0.0"],
  ] as const)("maps severity %s to level %s and security-severity %s", (severity, level, score) => {
    const log = parse(renderSarif([f({ severity })]));
    expect(log.runs[0]?.results[0]?.level).toBe(level);
    expect(log.runs[0]?.tool.driver.rules[0]?.properties["security-severity"]).toBe(score);
  });

  it("declares each engine/rule once and points results at it by index", () => {
    const log = parse(renderSarif([f({ message: "a" }), f({ message: "b" }), f({ engine: "plugin:semgrep", ruleId: "r.x", severity: "high", message: "c" })]));
    const { rules } = log.runs[0]!.tool.driver;
    expect(rules.map((r) => r.id)).toEqual(["plugin:semgrep/r.x", "supply-chain/wildcard-version"]);
    for (const r of log.runs[0]!.results) expect(rules[r.ruleIndex]?.id).toBe(r.ruleId);
    expect(rules[0]?.properties.tags).toEqual(["security"]);
  });

  it("uses the highest severity seen for a rule's default level", () => {
    const log = parse(renderSarif([f({ severity: "low", message: "a" }), f({ severity: "high", message: "b" })]));
    expect(log.runs[0]?.tool.driver.rules[0]?.defaultConfiguration.level).toBe("error");
  });

  it("omits the region without a line and locations without a file", () => {
    const log = parse(renderSarif([f({ line: undefined, message: "a" }), f({ file: undefined, line: undefined, message: "b" })]));
    const [withFile, project] = log.runs[0]!.results.sort((a, b) => a.message.text.localeCompare(b.message.text));
    expect(withFile?.locations?.[0]?.physicalLocation.region).toBeUndefined();
    expect(project?.locations).toBeUndefined();
  });

  it("percent-encodes URIs per path segment", () => {
    const log = parse(renderSarif([f({ file: "my dir/a#b%.json" })]));
    expect(log.runs[0]?.results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri).toBe("my%20dir/a%23b%25.json");
  });

  it("produces an empty but valid run for no findings", () => {
    const log = parse(renderSarif([]));
    expect(log.runs[0]?.results).toEqual([]);
    expect(log.runs[0]?.tool.driver.rules).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const xs = [f({ message: "a" }), f({ severity: "high", ruleId: "z", message: "b" }), f({ file: "y", message: "c" })];
    expect(renderSarif(xs)).toBe(renderSarif([...xs].reverse()));
  });

  it("renders 20k findings quickly", () => {
    const xs = Array.from({ length: 20_000 }, (_, i) => f({ line: i + 1, ruleId: `r${i % 100}`, message: `m${i}` }));
    const start = performance.now();
    parse(renderSarif(xs));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

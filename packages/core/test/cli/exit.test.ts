import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/cli/config.js";
import { EXIT, exitCodeFor, exitCodeForError, meetsThreshold } from "../../src/cli/exit.js";
import { createFinding, FindingError, type Severity } from "../../src/finding.js";
import { ScopeError } from "../../src/scope.js";
import { StoreError } from "../../src/store.js";
import { PluginError } from "../../src/plugins/base.js";

const f = (severity: Severity) => createFinding({ engine: "e", ruleId: "r", severity, message: `m-${severity}` });
const plugin = (status: "ok" | "error" | "timeout" | "crashed" | "invalid-output") =>
  ({ name: "p", status, findings: [], skipped: 0, truncated: false, durationMs: 1 }) as const;

describe("EXIT codes are stable", () => {
  it("never change value (CI scripts depend on them)", () => {
    expect(EXIT).toEqual({ OK: 0, FINDINGS: 1, USAGE: 2, SCAN_ERROR: 3, PARTIAL: 4 });
    expect(Object.isFrozen(EXIT)).toBe(true);
  });
});

describe("meetsThreshold", () => {
  it.each([
    ["critical", "high", true],
    ["high", "high", true],
    ["medium", "high", false],
    ["info", "low", false],
    ["low", "low", true],
    ["critical", "none", false],
  ] as const)("%s vs fail-on %s -> %s", (sev, failOn, expected) => {
    expect(meetsThreshold(sev, failOn)).toBe(expected);
  });
});

describe("exitCodeFor", () => {
  it("is OK with no findings", () => {
    expect(exitCodeFor({ findings: [], failOn: "low" })).toBe(EXIT.OK);
  });

  it("is FINDINGS when any finding meets the threshold", () => {
    expect(exitCodeFor({ findings: [f("info"), f("medium")], failOn: "medium" })).toBe(EXIT.FINDINGS);
  });

  it("is OK when all findings are below the threshold", () => {
    expect(exitCodeFor({ findings: [f("low"), f("info")], failOn: "medium" })).toBe(EXIT.OK);
  });

  it("never fails on findings with --fail-on none", () => {
    expect(exitCodeFor({ findings: [f("critical")], failOn: "none" })).toBe(EXIT.OK);
  });

  it.each(["error", "timeout", "crashed", "invalid-output"] as const)("is PARTIAL when a plugin ends with %s and nothing crosses the threshold", (status) => {
    expect(exitCodeFor({ findings: [f("info")], failOn: "low", plugins: [plugin("ok"), plugin(status)] })).toBe(EXIT.PARTIAL);
  });

  it("prefers FINDINGS over PARTIAL: a confirmed problem is the stronger signal", () => {
    expect(exitCodeFor({ findings: [f("high")], failOn: "high", plugins: [plugin("crashed")] })).toBe(EXIT.FINDINGS);
  });

  it("is OK when all plugins succeed", () => {
    expect(exitCodeFor({ findings: [], failOn: "low", plugins: [plugin("ok")] })).toBe(EXIT.OK);
  });
});

describe("exitCodeForError", () => {
  it("maps usage errors to USAGE", () => {
    expect(exitCodeForError(new ConfigError("bad flag"))).toBe(EXIT.USAGE);
  });

  it.each([
    ["ScopeError", new ScopeError("outside")],
    ["StoreError", new StoreError("corrupt")],
    ["FindingError", new FindingError("bad")],
    ["PluginError", new PluginError("bad")],
    ["fs error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })],
    ["unknown error", new Error("boom")],
    ["non-error throw", "string"],
  ])("maps %s to SCAN_ERROR", (_n, err) => {
    expect(exitCodeForError(err)).toBe(EXIT.SCAN_ERROR);
  });

  it("never returns OK or FINDINGS for an error", () => {
    for (const e of [new ConfigError("x"), new Error("y"), null, undefined]) {
      expect([EXIT.OK, EXIT.FINDINGS]).not.toContain(exitCodeForError(e));
    }
  });
});

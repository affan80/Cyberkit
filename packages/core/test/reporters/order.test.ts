import { afterEach, describe, expect, it, vi } from "vitest";
import { createFinding } from "../../src/finding.js";
import { compareFindings, sortFindings } from "../../src/reporters/order.js";

const mk = (file: string, ruleId = "r", severity = "low", line?: number) =>
  createFinding({ engine: "e", ruleId, severity, message: `${file}:${ruleId}`, file, line });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finding order is locale-independent (#60)", () => {
  it("orders files and rule ids by code unit, not by locale (uppercase before lowercase)", () => {
    const files = ["b.ts", "B.ts", "a.ts", "Z.ts", "ä.ts", "a10.ts", "a2.ts", "_x.ts", "src/a.ts", "src-b/a.ts"];
    const sorted = sortFindings(files.map((f) => mk(f))).map((f) => f.file);
    expect(sorted).toEqual([...files].sort()); // Array#sort default = UTF-16 code unit order
    expect(sorted).toEqual(["B.ts", "Z.ts", "_x.ts", "a.ts", "a10.ts", "a2.ts", "b.ts", "src-b/a.ts", "src/a.ts", "ä.ts"]);

    const rules = sortFindings(["b", "B", "a", "A"].map((r) => mk("x.ts", r))).map((f) => f.ruleId);
    expect(rules).toEqual(["A", "B", "a", "b"]);
  });

  it("never consults the runtime locale", () => {
    const spy = vi.spyOn(String.prototype, "localeCompare");
    sortFindings([mk("b"), mk("a"), mk("B")]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the rest of the total order: severity, then file, line, rule, id", () => {
    const fs = [mk("a.ts", "r", "low", 2), mk("a.ts", "r", "critical", 9), mk("a.ts", "r", "low", 1), mk("A.ts", "r", "low", 5)];
    expect(sortFindings(fs).map((f) => [f.severity, f.file, f.line])).toEqual([
      ["critical", "a.ts", 9],
      ["low", "A.ts", 5],
      ["low", "a.ts", 1],
      ["low", "a.ts", 2],
    ]);
    expect(compareFindings(fs[0]!, fs[0]!)).toBe(0);
  });
});

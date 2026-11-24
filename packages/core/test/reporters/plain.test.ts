import { describe, expect, it } from "vitest";
import { createFinding, type FindingInput } from "../../src/finding.js";
import { renderPlain } from "../../src/reporters/plain.js";

const f = (over: Partial<FindingInput> = {}) =>
  createFinding({ engine: "supply-chain", ruleId: "wildcard-version", severity: "medium", message: "left@* accepts any version", file: "package.json", line: 5, ...over });

describe("renderPlain", () => {
  it("says so when there are no findings", () => {
    expect(renderPlain([])).toBe("CyberKit: no findings\n");
  });

  it("renders one finding with location, engine/rule and message", () => {
    expect(renderPlain([f()])).toBe(
      ["CyberKit: 1 finding (1 medium)", "", "MEDIUM    package.json:5  supply-chain/wildcard-version", "          left@* accepts any version", ""].join("\n"),
    );
  });

  it("omits the line when absent and shows (project) when there is no file", () => {
    const out = renderPlain([f({ line: undefined }), f({ file: undefined, line: undefined, ruleId: "missing-lockfile", message: "m" })]);
    expect(out).toContain("MEDIUM    package.json  supply-chain/wildcard-version");
    expect(out).toContain("MEDIUM    (project)  supply-chain/missing-lockfile");
  });

  it("orders by severity (critical first), then file, line and rule", () => {
    const out = renderPlain([
      f({ severity: "low", message: "low" }),
      f({ severity: "critical", message: "crit" }),
      f({ severity: "medium", file: "b.json", message: "med-b" }),
      f({ severity: "medium", file: "a.json", line: 9, message: "med-a9" }),
      f({ severity: "medium", file: "a.json", line: 2, message: "med-a2" }),
    ]);
    const order = ["crit", "med-a2", "med-a9", "med-b", "low"].map((m) => out.indexOf(`          ${m}\n`));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > (order[i - 1] as number)))).toBe(true);
  });

  it("summarises counts in severity order and pluralises", () => {
    const out = renderPlain([f({ severity: "high", message: "a" }), f({ severity: "high", message: "b" }), f({ severity: "info", message: "c" })]);
    expect(out.split("\n")[0]).toBe("CyberKit: 3 findings (2 high, 1 info)");
  });

  it("is deterministic regardless of input order", () => {
    const xs = [f({ message: "a" }), f({ severity: "high", message: "b" }), f({ file: "z", message: "c" })];
    expect(renderPlain(xs)).toBe(renderPlain([...xs].reverse()));
  });

  it("does not mutate the input array", () => {
    const xs = Object.freeze([f({ severity: "low", message: "a" }), f({ severity: "high", message: "b" })]);
    expect(() => renderPlain(xs)).not.toThrow();
  });

  it("escapes control characters so findings cannot spoof the terminal or fake extra lines", () => {
    const out = renderPlain([f({ message: "evil\u001b[2J\u001b[31mFAKE\nMEDIUM    x  y/z\r\u0007done" })]);
    for (const c of ["\u001b", "\u0007", "\r"]) expect(out).not.toContain(c);
    expect(out).toContain("\\x1b[2J");
    expect(out).toContain("\\n");
    expect(out.split("\n").filter((l) => l.startsWith("MEDIUM"))).toHaveLength(1);
  });

  it("escapes Trojan-Source bidi controls", () => {
    const out = renderPlain([f({ message: "ok\u202e}lave\u2066x\u2069" })]);
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(out).toContain("\\u{202e}");
  });

  it("escapes control characters in file paths too", () => {
    const out = renderPlain([f({ file: "a\u001b]8;;x\u0007.json" })]);
    for (const c of ["\u001b", "\u0007"]) expect(out).not.toContain(c);
  });

  it("adds ANSI colour to severities only when asked", () => {
    expect(renderPlain([f()])).not.toContain("\u001b[");
    const coloured = renderPlain([f({ severity: "critical" })], { color: true });
    expect(coloured).toContain("\u001b[");
    expect(coloured).toContain("CRITICAL");
  });

  it("renders 50k findings quickly", () => {
    const xs = Array.from({ length: 50_000 }, (_, i) => f({ line: i + 1, message: `m${i}` }));
    const start = performance.now();
    const out = renderPlain(xs);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(out.startsWith("CyberKit: 50000 findings (50000 medium)")).toBe(true);
  });
});

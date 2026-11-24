import { describe, expect, it } from "vitest";
import { REDACTED } from "../src/redaction.js";
import { FindingError, SEVERITIES, createFinding, verifyFinding } from "../src/finding.js";

const base = { engine: "supply-chain", ruleId: "typosquat", severity: "high", message: "Suspicious package", file: "package.json", line: 12 } as const;
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("createFinding", () => {
  it("builds an immutable finding with a content-addressed id", () => {
    const f = createFinding(base);
    expect(f).toMatchObject(base);
    expect(f.id).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(f)).toBe(true);
    expect(() => {
      (f as { message: string }).message = "x";
    }).toThrow(TypeError);
  });

  it("gives identical ids for identical content (deterministic)", () => {
    expect(createFinding(base).id).toBe(createFinding({ ...base }).id);
  });

  it.each([
    ["ruleId", { ruleId: "other" }],
    ["severity", { severity: "low" }],
    ["message", { message: "different" }],
    ["file", { file: "other.json" }],
    ["line", { line: 13 }],
    ["engine", { engine: "plugin" }],
  ] as const)("changes the id when %s changes", (_n, change) => {
    expect(createFinding({ ...base, ...change }).id).not.toBe(createFinding(base).id);
  });

  it("does not collide when fields shift between neighbours", () => {
    const a = createFinding({ ...base, file: "ab", message: "c" });
    const b = createFinding({ ...base, file: "a", message: "bc" });
    expect(a.id).not.toBe(b.id);
  });

  it("redacts secrets in message and evidence at creation", () => {
    const f = createFinding({ ...base, message: `leaked ${GH}`, evidence: "password=hunter2" });
    expect(f.message).toContain(REDACTED);
    expect(f.message).not.toContain(GH);
    expect(f.evidence).not.toContain("hunter2");
    expect(JSON.stringify(f)).not.toContain(GH);
  });

  it("derives the id from redacted content, so secrets never influence it", () => {
    const a = createFinding({ ...base, message: "key password=aaaa" });
    const b = createFinding({ ...base, message: "key password=bbbb" });
    expect(a.id).toBe(b.id);
  });

  it("allows optional fields to be omitted", () => {
    const f = createFinding({ engine: "e", ruleId: "r", severity: "info", message: "m" });
    expect(f.file).toBeUndefined();
    expect(f.line).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const input = Object.freeze({ ...base });
    expect(() => createFinding(input)).not.toThrow();
  });

  it.each([
    ["empty ruleId", { ruleId: "" }],
    ["empty engine", { engine: "" }],
    ["empty message", { message: "" }],
    ["unknown severity", { severity: "urgent" }],
    ["zero line", { line: 0 }],
    ["fractional line", { line: 1.5 }],
    ["negative line", { line: -1 }],
    ["empty file", { file: "" }],
  ])("rejects %s", (_n, change) => {
    expect(() => createFinding({ ...base, ...change })).toThrow(FindingError);
  });

  it("exposes the known severities", () => {
    expect(SEVERITIES).toEqual(["info", "low", "medium", "high", "critical"]);
  });
});

describe("verifyFinding", () => {
  it("accepts a finding from createFinding", () => {
    expect(() => verifyFinding(JSON.parse(JSON.stringify(createFinding(base))))).not.toThrow();
  });

  it("rejects a tampered finding (id no longer matches content)", () => {
    const o = JSON.parse(JSON.stringify(createFinding(base)));
    o.message = "tampered";
    expect(() => verifyFinding(o)).toThrow(FindingError);
  });

  it.each([null, 5, "x", [], {}])("rejects non-finding value %j", (v) => {
    expect(() => verifyFinding(v)).toThrow(FindingError);
  });
});

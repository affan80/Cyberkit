import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFinding, type FindingInput } from "../../src/finding.js";
import { JSON_SCHEMA_VERSION, renderJson } from "../../src/reporters/json.js";
import { VERSION } from "../../src/version.js";

const f = (over: Partial<FindingInput> = {}) =>
  createFinding({ engine: "supply-chain", ruleId: "wildcard-version", severity: "medium", message: "m", file: "package.json", line: 5, ...over });

describe("VERSION", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("renderJson", () => {
  it("emits a versioned document with tool info, summary and findings", () => {
    const doc = JSON.parse(renderJson([f()]));
    expect(doc).toEqual({
      schemaVersion: JSON_SCHEMA_VERSION,
      tool: { name: "cyberkit", version: VERSION },
      summary: { total: 1, bySeverity: { critical: 0, high: 0, medium: 1, low: 0, info: 0 } },
      findings: [f()],
    });
  });

  it("handles no findings", () => {
    expect(JSON.parse(renderJson([]))).toMatchObject({ summary: { total: 0 }, findings: [] });
  });

  it("orders findings deterministically (severity first)", () => {
    const xs = [f({ severity: "low", message: "a" }), f({ severity: "critical", message: "b" }), f({ message: "c" })];
    const out = JSON.parse(renderJson(xs)) as { findings: { message: string }[] };
    expect(out.findings.map((x) => x.message)).toEqual(["b", "c", "a"]);
    expect(renderJson(xs)).toBe(renderJson([...xs].reverse()));
  });

  it("ends with a newline and is pretty-printed only when asked", () => {
    expect(renderJson([f()]).endsWith("\n")).toBe(true);
    expect(renderJson([f()]).split("\n")).toHaveLength(2);
    expect(renderJson([f()], { pretty: true }).split("\n").length).toBeGreaterThan(5);
  });

  it("escapes control characters safely (valid JSON, no raw ESC)", () => {
    const out = renderJson([f({ message: "a\u001b[2Jb\nc" })]);
    expect(out.includes("\u001b")).toBe(false);
    expect((JSON.parse(out) as { findings: { message: string }[] }).findings[0]?.message).toBe("a\u001b[2Jb\nc");
  });
});

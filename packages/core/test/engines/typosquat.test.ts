import { describe, expect, it } from "vitest";
import { type Manifest } from "../../src/engines/supply-chain.js";
import { createTyposquatCheck, isWithinOneEdit, skeleton, snapshot } from "../../src/engines/typosquat.js";

const check = createTyposquatCheck();
const run = (names: readonly string[]) =>
  check({ raw: "", hasLockfile: true, deps: names.map((name) => ({ name, spec: "1.0.0", section: "dependencies" as const })) } satisfies Manifest);

describe("isWithinOneEdit", () => {
  it.each([
    ["lodash", "lodahs", true], // transposition
    ["lodash", "lodas", true], // deletion
    ["lodash", "lodashh", true], // insertion
    ["lodash", "lodesh", true], // substitution
    ["lodash", "lodash", false], // identical is not an "edit"
    ["lodash", "lodxsy", false], // two edits
    ["lodash", "lod", false],
    ["abcd", "abdc", true],
  ])("%s ~ %s -> %s", (a, b, expected) => {
    expect(isWithinOneEdit(a, b)).toBe(expected);
    expect(isWithinOneEdit(b, a)).toBe(expected);
  });
});

describe("skeleton", () => {
  it("lowercases, drops separators and maps digit look-alikes", () => {
    expect(skeleton("Lo-Dash")).toBe("lodash");
    expect(skeleton("re_act.dom")).toBe("reactdom");
    expect(skeleton("l0dash")).toBe("lodash");
    expect(skeleton("expr3ss")).toBe("express");
  });
});

describe("typosquat check", () => {
  it.each([
    ["lodahs", "lodash"],
    ["expresss", "express"],
    ["reakt", "react"],
    ["chaik", "chalk"],
    ["axois", "axios"],
    ["typscript", "typescript"],
  ])("flags %s as resembling %s (medium)", (name, popular) => {
    const [r, ...rest] = run([name]);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ ruleId: "possible-typosquat", severity: "medium" });
    expect(r?.message).toContain(popular);
    expect(r?.dep?.name).toBe(name);
  });

  it.each([
    ["lo-dash", "lodash"],
    ["l0dash", "lodash"],
    ["expr3ss", "express"],
    ["react_dom", "react-dom"],
  ])("flags %s (same skeleton as %s) as high", (name, popular) => {
    const [r] = run([name]);
    expect(r).toMatchObject({ ruleId: "possible-typosquat", severity: "high" });
    expect(r?.message).toContain(popular);
  });

  it("never flags a package that is itself in the snapshot", () => {
    expect(run(snapshot.packages)).toEqual([]);
  });

  it("ignores scoped packages and very short names", () => {
    expect(run(["@evil/lodash", "@types/node", "ab", "left", "vuee"])).toEqual([]);
  });

  it("does not flag unrelated names", () => {
    expect(run(["my-internal-tool", "acme-billing-client", "zzzzzzzz"])).toEqual([]);
  });

  it("compares case-insensitively", () => {
    expect(run(["LODAHS"])).toHaveLength(1);
  });

  it("accepts a custom snapshot", () => {
    const custom = createTyposquatCheck({ version: 1, generatedAt: "2026-01-01", source: "test", packages: ["acme-core"] });
    const out = custom({ raw: "", hasLockfile: true, deps: [{ name: "acme-cor", spec: "1", section: "dependencies" }] });
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain("acme-core");
  });

  it("rejects a malformed snapshot", () => {
    expect(() => createTyposquatCheck({ packages: "nope" } as never)).toThrow(TypeError);
  });

  it("checks 20k dependency names quickly", () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `internal-package-${i}`);
    const start = performance.now();
    run(names);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

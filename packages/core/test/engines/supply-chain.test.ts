import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScope } from "../../src/scope.js";
import { REDACTED } from "../../src/redaction.js";
import { type Check, defaultChecks, scanSupplyChain } from "../../src/engines/supply-chain.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-sc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scan(pkg: unknown, opts: { lock?: string | false; raw?: string } = {}) {
  await writeFile(path.join(dir, "package.json"), opts.raw ?? JSON.stringify(pkg, null, 2));
  if (opts.lock !== false) await writeFile(path.join(dir, opts.lock ?? "package-lock.json"), "{}");
  return scanSupplyChain(await createScope(dir));
}
const rules = (fs: readonly { ruleId: string }[]) => fs.map((f) => f.ruleId);

describe("scanSupplyChain: clean and missing manifests", () => {
  it("returns no findings for a pinned project with a lockfile", async () => {
    expect(await scan({ dependencies: { left: "^1.2.3", right: "2.0.0" }, devDependencies: { t: "~3.1.0" } })).toEqual([]);
  });

  it("returns no findings when there is no package.json", async () => {
    expect(await scanSupplyChain(await createScope(dir))).toEqual([]);
  });

  it("returns no findings for a manifest with no dependencies, even without a lockfile", async () => {
    expect(await scan({ name: "x" }, { lock: false })).toEqual([]);
  });
});

describe("scanSupplyChain: dependency checks", () => {
  it.each(["*", "latest", "", "x", ">=0"])("flags wildcard version %j as medium", async (spec) => {
    const [f, ...rest] = await scan({ dependencies: { left: spec } });
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ engine: "supply-chain", ruleId: "wildcard-version", severity: "medium", file: "package.json" });
    expect(f?.message).toContain("left");
  });

  it("flags plain-http and git:// sources as high (insecure transport)", async () => {
    const fs = await scan({ dependencies: { a: "http://example.com/a.tgz", b: "git://example.com/b.git#abc1234" } });
    expect(fs.filter((f) => f.ruleId === "insecure-source").map((f) => f.severity)).toEqual(["high", "high"]);
  });

  it("flags credentials embedded in a dependency URL as high and redacts them", async () => {
    const fs = await scan({ dependencies: { a: "git+https://user:s3cr3tpw@example.com/a.git#abc1234", b: "https://tok3n@example.com/b.tgz" } });
    const creds = fs.filter((f) => f.ruleId === "credentials-in-url");
    expect(creds).toHaveLength(2);
    expect(creds.every((f) => f.severity === "high")).toBe(true);
    const all = JSON.stringify(fs);
    expect(all).not.toContain("s3cr3tpw");
    expect(all).not.toContain("tok3n");
    expect(all).toContain(REDACTED);
  });

  it("does not treat the normal git@ ssh user as credentials", async () => {
    const fs = await scan({ dependencies: { a: "git+ssh://git@github.com/o/a.git#abc1234" } });
    expect(rules(fs)).toEqual([]);
  });

  it.each(["github:o/r", "git+https://github.com/o/r.git", "o/r"])("flags unpinned git dependency %s as medium", async (spec) => {
    expect(rules(await scan({ dependencies: { a: spec } }))).toEqual(["unpinned-git-dependency"]);
  });

  it("accepts a git dependency pinned to a ref", async () => {
    expect(await scan({ dependencies: { a: "github:o/r#v1.2.3", b: "git+https://github.com/o/r.git#abc1234" } })).toEqual([]);
  });

  it("checks every dependency section", async () => {
    const fs = await scan({ dependencies: { a: "*" }, devDependencies: { b: "*" }, optionalDependencies: { c: "*" }, peerDependencies: { d: "*" } });
    expect(fs).toHaveLength(4);
    expect(fs.map((f) => f.message).join(" ")).toMatch(/devDependencies/);
  });

  it("reports the line number of the offending dependency", async () => {
    const fs = await scan({ name: "x", dependencies: { ok: "1.0.0", bad: "*" } });
    expect(fs[0]?.line).toBe(5);
  });

  it("flags a missing lockfile when dependencies exist", async () => {
    const fs = await scan({ dependencies: { a: "1.0.0" } }, { lock: false });
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ ruleId: "missing-lockfile", severity: "low" });
  });

  it.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"])("accepts %s as a lockfile", async (lock) => {
    expect(await scan({ dependencies: { a: "1.0.0" } }, { lock })).toEqual([]);
  });

  it("is deterministic: same input gives the same ids in the same order", async () => {
    const pkg = { dependencies: { a: "*", b: "latest" } };
    const a = await scan(pkg);
    const b = await scan(pkg);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });
});

describe("scanSupplyChain: hostile and broken input", () => {
  it("reports invalid JSON as a finding instead of crashing", async () => {
    const fs = await scan(undefined, { raw: "{ not json" });
    expect(rules(fs)).toEqual(["invalid-manifest"]);
  });

  it.each([[[]], ["str"], [null]])("reports a non-object manifest (%j) as invalid", async (value) => {
    expect(rules(await scan(undefined, { raw: JSON.stringify(value) }))).toEqual(["invalid-manifest"]);
  });

  it("ignores non-string versions and non-object sections safely", async () => {
    expect(await scan({ dependencies: { a: 5, b: null, c: { x: 1 } }, devDependencies: "nope" }, { lock: false })).toEqual([]);
  });

  it("handles __proto__ / constructor dependency names without polluting anything", async () => {
    await scan(undefined, { raw: '{"dependencies":{"__proto__":"*","constructor":"*"}}' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it("refuses an oversized manifest with a finding rather than reading it all", async () => {
    const fs = await scan(undefined, { raw: `{"a":"${"x".repeat(6 * 1024 * 1024)}"}` });
    expect(rules(fs)).toEqual(["invalid-manifest"]);
  });

  it("does not follow a package.json symlink that escapes the scope", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "cyberkit-sc-out-"));
    try {
      await writeFile(path.join(outside, "package.json"), JSON.stringify({ dependencies: { a: "*" } }));
      await symlink(path.join(outside, "package.json"), path.join(dir, "package.json"));
      await expect(scanSupplyChain(await createScope(dir))).rejects.toThrow(/scope/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("pluggable checks", () => {
  it("exposes the default checks and lets callers add their own", async () => {
    expect(defaultChecks.length).toBeGreaterThanOrEqual(4);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { evil: "1.0.0" } }));
    await writeFile(path.join(dir, "package-lock.json"), "{}");
    const custom: Check = (m) => m.deps.filter((d) => d.name === "evil").map((d) => ({ ruleId: "banned", severity: "critical", message: `${d.name} is banned`, dep: d }));
    const fs = await scanSupplyChain(await createScope(dir), { checks: [custom] });
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ ruleId: "banned", severity: "critical", file: "package.json" });
  });
});

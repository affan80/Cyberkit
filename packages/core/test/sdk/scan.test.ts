import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/cli/config.js";
import { EXIT } from "../../src/cli/exit.js";
import { ScopeError } from "../../src/scope.js";
import { definePlugin } from "../../src/plugins/base.js";
import { scan } from "../../src/sdk/scan.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/plugins");
let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-sdk-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "x");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const project = (deps: Record<string, string>) =>
  Promise.all([writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }, null, 2)), writeFile(path.join(dir, "package-lock.json"), "{}")]);
const plugin = (name: string, severity = "high", message = `from ${name}`) => definePlugin({ name, run: async () => [{ ruleId: "r", severity, message, file: "src/a.ts", line: 1 }] });

describe("scan()", () => {
  it("returns an empty, OK result for a clean project", async () => {
    await project({ react: "^18.0.0" });
    const res = await scan({ target: dir });
    expect(res).toMatchObject({ root: dir, findings: [], plugins: [], exitCode: EXIT.OK, summary: { total: 0 } });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(res)).toBe(true);
  });

  it("runs the supply-chain engine and reports FINDINGS", async () => {
    await project({ left: "*" });
    const res = await scan({ target: dir });
    expect(res.findings.map((f) => f.ruleId)).toEqual(["wildcard-version"]);
    expect(res.summary.bySeverity.medium).toBe(1);
    expect(res.exitCode).toBe(EXIT.FINDINGS);
  });

  it("applies failOn to the exit code", async () => {
    await project({ left: "*" });
    expect((await scan({ target: dir, failOn: "high" })).exitCode).toBe(EXIT.OK);
  });

  it("merges findings from engine and plugins, sorted by severity", async () => {
    await project({ left: "*" });
    const res = await scan({ target: dir, plugins: [plugin("alpha", "critical")] });
    expect(res.findings.map((f) => f.engine)).toEqual(["plugin:alpha", "supply-chain"]);
    expect(res.plugins.map((p) => [p.name, p.status])).toEqual([["alpha", "ok"]]);
  });

  it("deduplicates identical findings by id", async () => {
    await project({});
    const res = await scan({ target: dir, plugins: [plugin("dup"), plugin("dup")] });
    expect(res.findings).toHaveLength(1);
  });

  it("runs plugin modules in worker isolation", async () => {
    await project({});
    const res = await scan({ target: dir, plugins: [{ module: path.join(FIXTURES, "good.mjs") }] });
    expect(res.plugins[0]).toMatchObject({ name: "good", status: "ok" });
    expect(res.findings[0]?.engine).toBe("plugin:good");
  });

  it("reports PARTIAL when a plugin fails and nothing crosses the threshold", async () => {
    await project({});
    const res = await scan({ target: dir, plugins: [definePlugin({ name: "hang", run: () => new Promise(() => {}) })], pluginTimeoutMs: 100 });
    expect(res.plugins[0]?.status).toBe("timeout");
    expect(res.exitCode).toBe(EXIT.PARTIAL);
  });

  it("resolves the built-in semgrep plugin by name", async () => {
    await project({});
    const res = await scan({ target: dir, plugins: ["semgrep"] });
    expect(res.plugins[0]?.name).toBe("semgrep");
  });

  it("runs plugins concurrently, not one after another", async () => {
    await project({});
    const slow = (name: string) => definePlugin({ name, run: () => new Promise((r) => setTimeout(() => r([]), 300)) });
    const start = performance.now();
    await scan({ target: dir, plugins: [slow("a"), slow("b"), slow("c")] });
    expect(performance.now() - start).toBeLessThan(800);
  });

  it("accepts custom supply-chain checks", async () => {
    await project({ left: "*" });
    const res = await scan({ target: dir, checks: [] });
    expect(res.findings).toEqual([]);
  });

  it("defaults the target to the current directory", async () => {
    const res = await scan({ checks: [] });
    expect(res.root).toBe(await realpath(process.cwd()));
  });

  it("throws ScopeError for a missing target", async () => {
    await expect(scan({ target: path.join(dir, "missing") })).rejects.toThrow(ScopeError);
  });

  it("throws ConfigError for an unknown built-in plugin or invalid failOn", async () => {
    await expect(scan({ target: dir, plugins: ["nope"] })).rejects.toThrow(ConfigError);
    await expect(scan({ target: dir, failOn: "sometimes" as never })).rejects.toThrow(ConfigError);
  });
});

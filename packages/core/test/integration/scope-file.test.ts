import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, createScope, definePlugin, scan, scanSupplyChain } from "../../src/index.js";
import { runCli } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-scopefile-int-")));
  await mkdir(path.join(dir, "src"));
  await mkdir(path.join(dir, "vendor", "lib"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.js"), "x");
  await writeFile(path.join(dir, "vendor", "lib", "b.js"), "x");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { left: "*" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const scopeFile = async (value: unknown) => {
  await mkdir(path.join(dir, ".cyberkit"), { recursive: true });
  await writeFile(path.join(dir, ".cyberkit", "scope.json"), JSON.stringify(value));
};
const reporter = definePlugin({
  name: "reporter",
  run: async () => [
    { ruleId: "r", severity: "high", message: "in src", file: "src/a.js", line: 1 },
    { ruleId: "r", severity: "high", message: "in vendor", file: "vendor/lib/b.js", line: 1 },
  ],
});

describe("scope files end to end", () => {
  it("drops plugin findings in excluded paths and counts them as skipped", async () => {
    await scopeFile({ version: 1, exclude: ["vendor"] });
    const res = await scan({ target: dir, plugins: [reporter], checks: [] });
    expect(res.findings.map((f) => f.message)).toEqual(["in src"]);
    expect(res.plugins[0]?.skipped).toBe(1);
  });

  it("does not scan an excluded package.json", async () => {
    await scopeFile({ version: 1, exclude: ["package.json"] });
    expect(await scanSupplyChain(await createScope(dir))).toEqual([]);
  });

  it("treats an excluded lockfile as absent", async () => {
    await scopeFile({ version: 1, exclude: ["package-lock.json"] });
    const fs = await scanSupplyChain(await createScope(dir));
    expect(fs.map((f) => f.ruleId).sort()).toEqual(["missing-lockfile", "wildcard-version"]);
  });

  it("include narrows the scan to the listed paths", async () => {
    await scopeFile({ version: 1, include: ["src"] });
    const res = await scan({ target: dir, plugins: [reporter] });
    expect(res.findings.map((f) => f.message)).toEqual(["in src"]);
    expect(res.findings.some((f) => f.engine === "supply-chain")).toBe(false);
  });

  it("the CLI honours the scope file", async () => {
    expect((await runCli(["scan", dir])).code).toBe(EXIT.FINDINGS);
    await scopeFile({ version: 1, exclude: ["package.json"] });
    expect(await runCli(["scan", dir])).toMatchObject({ code: EXIT.OK, stdout: "CyberKit: no findings\n" });
  });

  it("the CLI exits 2 with a clear message for an invalid scope file", async () => {
    await scopeFile({ version: 1, exlude: ["vendor"] });
    const r = await runCli(["scan", dir]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain('.cyberkit/scope.json: unknown scope config key "exlude"');
  });
});

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BIN, makeProject, runCli } from "./helpers.js";

const created: string[] = [];
const project = async (...args: Parameters<typeof makeProject>) => {
  const dir = await makeProject(...args);
  created.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

describe("cyberkit CLI (real binary, end to end)", () => {
  it("--help prints usage and exit codes, exit 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: cyberkit scan");
    expect(r.stdout).toContain("Exit codes:");
    expect(r.stderr).toBe("");
  });

  it("--version prints the package version", async () => {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(BIN), "..", "package.json"), "utf8")) as { version: string };
    expect((await runCli(["--version"])).stdout).toBe(`${pkg.version}\n`);
  });

  it("exit 0 and 'no findings' for a clean project", async () => {
    const r = await runCli(["scan", await project({ react: "^18.0.0" })]);
    expect(r).toMatchObject({ code: 0, stdout: "CyberKit: no findings\n", stderr: "" });
  });

  it("exit 1 with a readable report when findings meet the threshold", async () => {
    const r = await runCli(["scan", await project({ lodahs: "1.0.0", left: "*" })]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^CyberKit: 2 findings \(2 medium\)/);
    expect(r.stdout).toContain("supply-chain/possible-typosquat");
  });

  it("--fail-on raises the bar (exit 0) and still prints the findings", async () => {
    const r = await runCli(["scan", await project({ left: "*" }), "--fail-on", "high"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wildcard-version");
  });

  it("scans the current directory by default", async () => {
    const dir = await project({ left: "*" });
    expect((await runCli(["scan"], { cwd: dir })).code).toBe(1);
  });

  it("emits valid JSON and SARIF on stdout", async () => {
    const dir = await project({ left: "*" });
    const json = JSON.parse((await runCli(["scan", dir, "-f", "json"])).stdout) as { summary: { total: number } };
    expect(json.summary.total).toBe(1);
    const sarif = JSON.parse((await runCli(["scan", dir, "-f", "sarif"])).stdout) as { version: string; runs: { results: unknown[] }[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.results).toHaveLength(1);
  });

  it("--output writes the file and keeps stdout empty", async () => {
    const dir = await project({ left: "*" });
    const out = path.join(dir, "reports", "r.json");
    const r = await runCli(["scan", dir, "-f", "json", "-o", out]);
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect((JSON.parse(await readFile(out, "utf8")) as { summary: { total: number } }).summary.total).toBe(1);
  });

  it("exit 2 with usage hint on stderr for bad arguments", async () => {
    const r = await runCli(["scan", "--format", "pdf"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('Run "cyberkit --help" for usage.');
  });

  it("exit 3 for a missing target", async () => {
    const dir = await project({});
    const r = await runCli(["scan", path.join(dir, "nope")]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^cyberkit: /);
  });

  it("exit 4 when a plugin fails and nothing crosses the threshold", async () => {
    const r = await runCli(["scan", await project({}), "-p", "semgrep"], { env: { PATH: "/nonexistent" } });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("plugin semgrep: error");
  });

  it("never prints a secret from the scanned project, in any format", async () => {
    const dir = await project({ b: "git+https://user:hunter2pw@example.com/b.git" });
    for (const f of ["text", "json", "sarif"]) {
      const r = await runCli(["scan", dir, "-f", f]);
      expect(r.stdout + r.stderr).not.toContain("hunter2pw");
    }
  });

  it("does not colour output when stdout is not a TTY", async () => {
    expect((await runCli(["scan", await project({ left: "*" })])).stdout).not.toContain("\u001b[");
  });

  it("does not crash when the reader closes the pipe early (EPIPE, or ENOTCONN on macOS)", async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) deps[`dep${i}`] = "*";
    const dir = await project(deps);
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, "scan", dir], { env: { PATH: process.env.PATH ?? "" } });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdout.once("data", () => child.stdout.destroy());
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/EPIPE|Error/);
  });

  it("scans a 5,000-dependency project in a few seconds", async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) deps[`internal-${i}`] = "^1.0.0";
    const dir = await project(deps);
    const start = performance.now();
    const r = await runCli(["scan", dir]);
    expect(r.code).toBe(0);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

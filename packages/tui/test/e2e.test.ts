import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cyberkit-tui");
let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "ck-tui-e2e-")));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", b: "git+https://user:hunter2pw@example.com/b.git" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("cyberkit-tui binary (built dist, end to end)", () => {
  it("--frame scans a real project and prints a full frame with the scan's exit code", async () => {
    const r = await run([dir, "--frame", "--cols", "110", "--rows", "28"]);
    expect(r.code).toBe(1);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(28);
    expect(r.stdout).toContain("possible-typosquat");
    expect(r.stdout).toContain("credentials-in-url");
    expect(r.stdout).not.toContain("hunter2pw");
  });

  it("refuses to go interactive without a TTY", async () => {
    const r = await run([dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs an interactive terminal");
  });
});

/** Shared helpers for tests that run the real, built `cyberkit` binary. */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BIN = path.join(PKG_DIR, "bin", "cyberkit");

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built CLI with a minimal environment (no colour, no inherited secrets). */
export function runCli(args: readonly string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? PKG_DIR,
      env: { PATH: process.env.PATH ?? "", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Creates a temp project with the given dependencies (and a lockfile unless disabled). */
export async function makeProject(deps: Record<string, string>, opts: { lockfile?: boolean; files?: Record<string, string> } = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-e2e-")));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: deps }, null, 2));
  if (opts.lockfile !== false) await writeFile(path.join(dir, "package-lock.json"), "{}");
  for (const [name, content] of Object.entries(opts.files ?? {})) await writeFile(path.join(dir, name), content);
  return dir;
}

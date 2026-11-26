import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { neutralCwd, resolveExecutable } from "../../src/plugins/exec.js";

const posix = process.platform !== "win32";

let root: string; // scanned (untrusted) tree
let bin: string; // a trusted PATH directory outside it
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-exec-root-")));
  bin = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-exec-bin-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

const tool = async (dir: string, name = "tool", mode = 0o755) => {
  const p = path.join(dir, name);
  await writeFile(p, "#!/bin/sh\nexit 0\n");
  await chmod(p, mode);
  return p;
};
const join = (...dirs: string[]) => dirs.join(path.delimiter);

describe.runIf(posix)("resolveExecutable", () => {
  it("finds a tool on PATH and returns its absolute path", async () => {
    const p = await tool(bin);
    expect(await resolveExecutable("tool", { pathEnv: join("/nonexistent", bin), root })).toBe(p);
  });

  it.each([
    ["an empty entry (trailing ':')", (b: string) => `${b}${path.delimiter}`],
    ["an empty entry (leading ':')", (b: string) => `${path.delimiter}${b}`],
    ["a doubled ':'", (b: string) => `/usr/bin${path.delimiter}${path.delimiter}${b}`],
    ["'.'", (b: string) => join(".", b)],
    ["a relative entry", (b: string) => join("node_modules/.bin", b)],
  ])("never resolves to the cwd via %s (issue #47)", async (_label, pathFor) => {
    await tool(root);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await resolveExecutable("tool", { pathEnv: pathFor(bin), root })).toBeUndefined();
      const good = await tool(bin);
      expect(await resolveExecutable("tool", { pathEnv: pathFor(bin), root })).toBe(good);
    } finally {
      process.chdir(cwd);
    }
  });

  it("skips absolute PATH entries inside the scan root", async () => {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await tool(path.join(root, "node_modules", ".bin"));
    const good = await tool(bin);
    expect(await resolveExecutable("tool", { pathEnv: join(path.join(root, "node_modules", ".bin"), bin), root })).toBe(good);
  });

  it("skips a PATH entry that is a symlink into the scan root, and a tool symlinked into it", async () => {
    await tool(root, "evil");
    await symlink(root, path.join(bin, "linked-dir"));
    await symlink(path.join(root, "evil"), path.join(bin, "tool"));
    expect(await resolveExecutable("evil", { pathEnv: path.join(bin, "linked-dir"), root })).toBeUndefined();
    expect(await resolveExecutable("tool", { pathEnv: bin, root })).toBeUndefined();
  });

  it("ignores non-executable files and directories", async () => {
    await tool(bin, "tool", 0o644);
    await mkdir(path.join(bin, "dir"));
    expect(await resolveExecutable("tool", { pathEnv: bin, root })).toBeUndefined();
    expect(await resolveExecutable("dir", { pathEnv: bin, root })).toBeUndefined();
  });

  it("returns undefined for an empty name or PATH", async () => {
    expect(await resolveExecutable("", { pathEnv: bin, root })).toBeUndefined();
    expect(await resolveExecutable("tool", { pathEnv: undefined, root })).toBeUndefined();
  });

  it("uses an explicit path as given (resolved against the process cwd)", async () => {
    expect(await resolveExecutable("/opt/semgrep/bin/semgrep", { pathEnv: "", root })).toBe("/opt/semgrep/bin/semgrep");
    expect(await resolveExecutable("./x/semgrep", { pathEnv: "", root })).toBe(path.resolve("x/semgrep"));
  });
});

describe("neutralCwd", () => {
  it("is outside the scan root", async () => {
    const rel = path.relative(root, await realpath(neutralCwd()));
    expect(rel.startsWith("..")).toBe(true);
  });
});

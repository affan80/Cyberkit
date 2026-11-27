import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCommands, findRepoRoot, npmArgv } from "../src/commands.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-dev-cmd-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pkg = async (dir: string, json: unknown) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), typeof json === "string" ? json : JSON.stringify(json));
};

describe("discoverCommands", () => {
  it("lists root and workspace scripts, filters lifecycle hooks and bad names, and composes the checks chain", async () => {
    await pkg(root, {
      workspaces: ["packages/*", "tools/extra"],
      scripts: { lint: "eslint .", build: "tsc", test: "vitest", pretest: "npm run build", posttest: "echo", prepare: "husky", "bad name;rm": "x", typecheck: "tsc --noEmit", premium: "echo premium" },
    });
    await pkg(path.join(root, "packages/b-tui"), { name: "@cyberkit/tui", scripts: { test: "vitest run", pretest: "npm run build" } });
    await pkg(path.join(root, "packages/a-core"), { name: "@cyberkit/core", scripts: { build: "tsc" } });
    await pkg(path.join(root, "packages/broken"), "{ nope");
    await mkdir(path.join(root, "packages/empty"), { recursive: true });
    await pkg(path.join(root, "tools/extra"), { scripts: { go: "node go.js" } });

    const cmds = await discoverCommands(root, { platform: "linux" });
    expect(cmds.map((c) => c.id)).toEqual([
      "chain:verify",
      "root:lint",
      "root:build",
      "root:test",
      "root:typecheck",
      "root:premium",
      "core:build",
      "tui:test",
      "extra:go",
    ]);
    const verify = cmds[0];
    expect(verify).toMatchObject({ group: "checks", name: "verify", steps: ["root:lint", "root:typecheck", "root:build", "root:test"], description: "lint → typecheck → build → test" });
    expect(cmds.find((c) => c.id === "root:test")).toMatchObject({ group: "root", name: "test", description: "vitest", argv: ["npm", "run", "test"], cwd: root });
    expect(cmds.find((c) => c.id === "tui:test")).toMatchObject({ group: "tui", cwd: path.join(root, "packages/b-tui") });
  });

  it("omits the chain without checks and adds the scan tool when the core bin exists", async () => {
    await pkg(root, { scripts: { start: "node ." } });
    await mkdir(path.join(root, "packages/core/bin"), { recursive: true });
    await writeFile(path.join(root, "packages/core/bin/cyberkit"), "#!/usr/bin/env node\n");
    const cmds = await discoverCommands(root, { platform: "linux", execPath: "/usr/bin/node" });
    expect(cmds.map((c) => c.id)).toEqual(["root:start", "tool:scan"]);
    expect(cmds[1]).toMatchObject({ group: "tools", name: "scan this repo", argv: ["/usr/bin/node", path.join(root, "packages/core/bin/cyberkit"), "scan", "."], cwd: root });
  });

  it("hides scripts that open the console itself", async () => {
    await pkg(root, { scripts: { ui: "cyberkit-dev", "ui:frame": "cyberkit-dev --frame", "ui:node": "node packages/dev/bin/cyberkit-dev", "ui:win": "node packages\\dev\\bin\\cyberkit-dev --list", test: "vitest" } });
    expect((await discoverCommands(root)).map((c) => c.id)).toEqual(["chain:verify", "root:test"]);
  });

  it("uses cmd.exe on Windows", async () => {
    expect(npmArgv("test", "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "npm", "run", "test"]);
    await pkg(root, { scripts: { test: "x" } });
    expect((await discoverCommands(root, { platform: "win32" })).find((c) => c.id === "root:test")?.argv).toEqual(npmArgv("test", "win32"));
  });

  it("throws a clear error for an invalid root package.json", async () => {
    await pkg(root, "{ broken");
    await expect(discoverCommands(root)).rejects.toThrow(/package\.json/);
  });
});

describe("findRepoRoot", () => {
  it("finds the workspace root from a nested directory, else the nearest package.json, else the start", async () => {
    await pkg(root, { workspaces: ["packages/*"] });
    await pkg(path.join(root, "packages/x"), { name: "x" });
    await mkdir(path.join(root, "packages/x/src/deep"), { recursive: true });
    expect(await findRepoRoot(path.join(root, "packages/x/src/deep"))).toBe(root);

    const solo = path.join(root, "solo");
    await pkg(solo, { name: "solo" });
    await mkdir(path.join(solo, "lib"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "no-workspaces" }));
    expect(await findRepoRoot(path.join(solo, "lib"))).toBe(solo);
  });
});

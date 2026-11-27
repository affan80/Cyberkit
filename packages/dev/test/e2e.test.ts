/** The real bin, spawned as a user would run it (requires `npm run build`; `npm test` builds first). */
import { spawnSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureRepo, NODE_SCRIPTS } from "./helpers.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cyberkit-dev");
const built = await access(path.resolve(path.dirname(BIN), "../dist/cli.js")).then(() => true, () => false);

let root: string;
beforeAll(async () => {
  root = await fixtureRepo({ test: NODE_SCRIPTS.tsError, lint: NODE_SCRIPTS.pass });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 });

describe.runIf(built)("bin/cyberkit-dev (end to end)", () => {
  it("lists, runs and reports errors like a user would see them", () => {
    const list = cli("--list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("chain:verify");

    const run = cli("--run", "root:test");
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("typescript  src/a.ts:3:5  TS2322");

    const errors = cli("--errors");
    expect(errors.status).toBe(0);
    expect(errors.stdout).toMatch(/error log: test · failed/);

    const refuse = cli();
    expect(refuse.status).toBe(2);
    expect(refuse.stderr).toMatch(/needs an interactive terminal/);
  }, 60_000);

  it("caches runs under node_modules/.cache/cyberkit-dev", async () => {
    await expect(access(path.join(root, "node_modules", ".cache", "cyberkit-dev", "history.json"))).resolves.toBeUndefined();
  });
});

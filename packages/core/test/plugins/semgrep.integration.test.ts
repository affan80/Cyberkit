import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, createSemgrepPlugin, createStore, runPlugin, scanSupplyChain } from "../../src/index.js";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/bin/fake-semgrep.mjs");
let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-semgrep-int-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.js"), "x");
  await writeFile(path.join(dir, ".semgrep.yml"), "rules: []\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env = (mode: string, extra: Record<string, string> = {}) => ({ FAKE_SEMGREP_MODE: mode, PATH: process.env.PATH ?? "", ...extra });

describe("semgrep plugin in a full scan (public API)", () => {
  it("engine + semgrep findings land in one store with no secrets on disk", async () => {
    const scope = await createScope(dir);
    const [engine, semgrep] = await Promise.all([
      scanSupplyChain(scope),
      runPlugin(createSemgrepPlugin({ binary: FAKE, env: env("results") }), scope),
    ]);
    const storePath = path.join(dir, "out", "findings.jsonl");
    const store = createStore(storePath);
    await store.appendMany([...engine, ...semgrep.findings]);

    const engines = (await store.readAll()).map((f) => f.engine);
    expect(engines).toEqual(["supply-chain", "plugin:semgrep", "plugin:semgrep"]);
    expect(await readFile(storePath, "utf8")).not.toContain("hunter2");
  });

  it("a timed-out semgrep process is actually killed (no orphan)", async () => {
    const pidFile = path.join(dir, "semgrep.pid");
    const res = await runPlugin(createSemgrepPlugin({ binary: FAKE, env: env("hang", { FAKE_SEMGREP_PID_FILE: pidFile }) }), await createScope(dir), { timeoutMs: 500 });
    expect(res.status).toBe("timeout");
    const pid = Number(await readFile(pidFile, "utf8"));
    const alive = async () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && (await alive()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await alive()).toBe(false);
  });
});

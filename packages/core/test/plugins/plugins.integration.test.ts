import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, createStore, definePlugin, runPlugin, runPluginModule } from "../../src/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/plugins");
let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-plugins-int-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "x");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a scan with misbehaving plugins (public API)", () => {
  it("keeps results from good plugins while bad ones crash, hang or throw", async () => {
    const scope = await createScope(dir);
    const results = await Promise.all([
      runPluginModule(path.join(FIXTURES, "good.mjs"), scope),
      runPluginModule(path.join(FIXTURES, "infinite-loop.mjs"), scope, { timeoutMs: 200 }),
      runPluginModule(path.join(FIXTURES, "exits.mjs"), scope),
      runPlugin(definePlugin({ name: "leaky", run: async () => [{ ruleId: "r", severity: "high", message: "password=hunter2" }] }), scope),
      runPlugin(definePlugin({ name: "broken", run: async () => { throw new Error("x"); } }), scope),
    ]);
    expect(results.map((r) => r.status)).toEqual(["ok", "timeout", "crashed", "ok", "error"]);

    const store = createStore(path.join(dir, "out", "findings.jsonl"));
    await store.appendMany(results.flatMap((r) => r.findings));
    expect((await store.readAll()).map((f) => f.engine)).toEqual(["plugin:good", "plugin:leaky"]);
    expect(await readFile(path.join(dir, "out", "findings.jsonl"), "utf8")).not.toContain("hunter2");
  });
});

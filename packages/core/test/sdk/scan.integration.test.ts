import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, createSemgrepPlugin, createStore, renderJson, renderPlain, renderSarif, scan } from "../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(HERE, "../fixtures/bin/fake-semgrep.mjs");
const GOOD = path.resolve(HERE, "../fixtures/plugins/good.mjs");
let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-sdk-int-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.js"), "x");
  await writeFile(path.join(dir, "src", "a.ts"), "x");
  await writeFile(path.join(dir, ".semgrep.yml"), "rules: []\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", b: "git+https://user:hunter2pw@example.com/b.git#v1" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scan() end to end (public API)", () => {
  it("engine + semgrep + worker plugin -> one result -> every reporter and the store, no secrets anywhere", async () => {
    const semgrep = createSemgrepPlugin({ binary: FAKE, env: { FAKE_SEMGREP_MODE: "results", PATH: process.env.PATH ?? "" } });
    const res = await scan({ target: dir, plugins: [semgrep, { module: GOOD }], failOn: "high" });

    expect(res.plugins.map((p) => [p.name, p.status])).toEqual([["semgrep", "ok"], ["good", "ok"]]);
    expect(new Set(res.findings.map((f) => f.engine))).toEqual(new Set(["supply-chain", "plugin:semgrep", "plugin:good"]));
    expect(res.exitCode).toBe(EXIT.FINDINGS);

    const store = createStore(path.join(dir, "out", "findings.jsonl"));
    await store.appendMany(res.findings);
    expect(await store.readAll()).toEqual(res.findings);

    const outputs = [renderPlain(res.findings), renderJson(res.findings), renderSarif(res.findings), await readFile(path.join(dir, "out", "findings.jsonl"), "utf8")];
    for (const out of outputs) {
      expect(out).not.toContain("hunter2pw");
      expect(out).not.toContain("hunter2");
    }
  });

  it("gives identical results on repeated runs (deterministic ids and order)", async () => {
    const a = await scan({ target: dir });
    const b = await scan({ target: dir });
    expect(b.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id));
  });
});

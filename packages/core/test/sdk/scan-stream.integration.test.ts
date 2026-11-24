import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSemgrepPlugin, createStore, scan, scanStream } from "../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(HERE, "../fixtures/bin/fake-semgrep.mjs");
let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-stream-int-")));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.js"), "x");
  await writeFile(path.join(dir, ".semgrep.yml"), "rules: []\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", c: "*" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanStream() end to end (public API)", () => {
  it("streams straight into the store with the same content as scan()", async () => {
    const plugins = [createSemgrepPlugin({ binary: FAKE, env: { FAKE_SEMGREP_MODE: "results", PATH: process.env.PATH ?? "" } })];
    const store = createStore(path.join(dir, "out", "stream.jsonl"));
    let exitCode = -1;
    for await (const e of scanStream({ target: dir, plugins })) {
      if (e.type === "finding") await store.append(e.finding);
      if (e.type === "end") exitCode = e.exitCode;
    }
    const result = await scan({ target: dir, plugins });
    expect((await store.readAll()).map((f) => f.id).sort()).toEqual(result.findings.map((f) => f.id).sort());
    expect(exitCode).toBe(result.exitCode);
  });
});

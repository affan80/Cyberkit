import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScope, createStore, scanSupplyChain } from "../../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-sc-int-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("supply-chain engine (public API)", () => {
  it("scope -> engine -> store: findings persist without any secret on disk", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { a: "*", b: "git+https://user:hunter2pw@example.com/b.git", c: "http://example.com/c.tgz" } }, null, 2),
    );
    const scope = await createScope(dir);
    const findings = await scanSupplyChain(scope);
    expect(findings.length).toBeGreaterThanOrEqual(5);

    const storePath = await scope.resolve("out/findings.jsonl");
    const store = createStore(storePath);
    await store.appendMany(findings);

    expect(await store.readAll()).toEqual(findings);
    expect(await readFile(storePath, "utf8")).not.toContain("hunter2pw");
  });

  it("re-running on unchanged input yields identical finding ids", async () => {
    const scope = await createScope(dir);
    const first = (await scanSupplyChain(scope)).map((f) => f.id);
    const second = (await scanSupplyChain(scope)).map((f) => f.id);
    expect(second).toEqual(first);
  });

  it("scans a manifest with 20k dependencies quickly and locates lines correctly", async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) deps[`pkg-${i}`] = i === 19_999 ? "*" : "1.0.0";
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }, null, 2));
    await writeFile(path.join(dir, "package-lock.json"), "{}");

    const start = performance.now();
    const findings = await scanSupplyChain(await createScope(dir));
    const elapsed = performance.now() - start;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(20_001 + 1); // "{", "dependencies", then one line per dep
    expect(elapsed).toBeLessThan(2000);
  });
});

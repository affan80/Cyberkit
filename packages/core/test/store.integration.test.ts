import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFinding, createStore, createScope } from "../src/index.js";

let dir: string;
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-store-int-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findings + store (public API)", () => {
  it("secrets never reach the file on disk", async () => {
    const store = createStore(path.join(dir, "secrets.jsonl"));
    await store.append(createFinding({ engine: "e", ruleId: "leak", severity: "critical", message: `token ${GH}`, evidence: "password=hunter2" }));
    const raw = await readFile(path.join(dir, "secrets.jsonl"), "utf8");
    expect(raw).not.toContain(GH);
    expect(raw).not.toContain("hunter2");
  });

  it("creates missing parent directories and works with a scope-validated path", async () => {
    const scope = await createScope(dir);
    const target = await scope.resolve("out/findings.jsonl");
    const store = createStore(target);
    await store.append(createFinding({ engine: "e", ruleId: "r", severity: "info", message: "m" }));
    expect(await store.count()).toBe(1);
  });

  it("keeps every line intact under heavy concurrent appends", async () => {
    const store = createStore(path.join(dir, "concurrent.jsonl"));
    const findings = Array.from({ length: 500 }, (_, i) => createFinding({ engine: "e", ruleId: `r${i}`, severity: "low", message: "x".repeat(2000), line: i + 1 }));
    await Promise.all(findings.map((f) => store.append(f)));
    const back = await store.readAll();
    expect(back).toHaveLength(500);
    expect(new Set(back.map((f) => f.id)).size).toBe(500);
  });

  it("writes and streams 20k findings quickly with bounded work per record", async () => {
    const store = createStore(path.join(dir, "big.jsonl"));
    const batch = Array.from({ length: 20_000 }, (_, i) => createFinding({ engine: "e", ruleId: `r${i % 50}`, severity: "low", message: `finding ${i}`, line: i + 1 }));
    const start = performance.now();
    await store.appendMany(batch);
    let n = 0;
    for await (const f of store.iterate()) if (f.id) n++;
    expect(n).toBe(20_000);
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it("the same finding gets the same id across runs", () => {
    const mk = () => createFinding({ engine: "e", ruleId: "r", severity: "low", message: "m", file: "a.ts", line: 3 });
    expect(mk().id).toBe(mk().id);
  });
});

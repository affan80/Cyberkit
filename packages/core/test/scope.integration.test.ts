import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScopeError, createScope, redact } from "../src/index.js";

let base: string;
let root: string;
const SECRET = "password=hunter2-outside";

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-scope-int-")));
  root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "pkg", "nested"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "env"), SECRET);
  for (let i = 0; i < 200; i++) await writeFile(path.join(root, "pkg", `f${i}.ts`), `// ${i}`);
  await writeFile(path.join(root, "pkg", "nested", "ok.ts"), "ok");
  await symlink(outside, path.join(root, "pkg", "escape"));
  await symlink(path.join(root, "pkg", "nested"), path.join(root, "alias"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    out.push(p);
    if (entry.isDirectory()) out.push(...(await walk(p)));
  }
  return out;
}

describe("scope (public API, real directory tree)", () => {
  it("lets a scanner walk the tree and only ever read in-scope files", async () => {
    const scope = await createScope(root);
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const p of await walk(root)) {
      (await scope.contains(p) ? accepted : rejected).push(p);
    }
    expect(rejected).toEqual([path.join(root, "pkg", "escape")]);
    expect(accepted).toContain(path.join(root, "pkg", "nested", "ok.ts"));
    expect(accepted).toContain(path.join(root, "alias"));
    expect(accepted).toHaveLength(200 + 4); // 200 files + pkg, nested, ok.ts, alias
  });

  it("never exposes outside content: escape attempts fail before any read", async () => {
    const scope = await createScope(root);
    await expect(scope.resolve("pkg/escape/env")).rejects.toThrow(ScopeError);
  });

  it("composes with redaction for text found in scope", async () => {
    const scope = await createScope(root);
    const p = await scope.resolve("pkg/nested/ok.ts");
    expect(redact(`${p}: ${SECRET}`)).not.toContain("hunter2");
  });

  it("is safe and fast under concurrency", async () => {
    const scope = await createScope(root);
    const inputs = Array.from({ length: 2000 }, (_, i) =>
      i % 4 === 0 ? "pkg/escape/env" : `pkg/f${i % 200}.ts`,
    );
    const start = performance.now();
    const results = await Promise.all(inputs.map((i) => scope.contains(i)));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(results.filter(Boolean)).toHaveLength(1500);
  });

  it("returns a frozen scope that cannot be re-pointed", async () => {
    const scope = await createScope(root);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => {
      (scope as { root: string }).root = "/";
    }).toThrow(TypeError);
  });
});

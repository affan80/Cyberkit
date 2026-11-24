import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScopeError, createScope } from "../src/scope.js";

let base: string; // realpath of the sandbox
let root: string; // <base>/project  (the scan target)
let outside: string; // <base>/secret   (must never be reachable)

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-scope-")));
  root = path.join(base, "project");
  outside = path.join(base, "secret");
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(outside);
  await mkdir(path.join(base, "project-evil"));
  await writeFile(path.join(root, "src", "a.ts"), "x");
  await writeFile(path.join(outside, "key.txt"), "top secret");
  await writeFile(path.join(base, "project-evil", "f.txt"), "x");
  await symlink(path.join(root, "src"), path.join(root, "link-inside"));
  await symlink(outside, path.join(root, "link-outside"));
  await symlink(path.join(outside, "key.txt"), path.join(root, "file-link-outside"));
  await symlink(path.join(outside, "not-yet.txt"), path.join(root, "dangling-outside"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("createScope", () => {
  it("exposes the realpath of the root", async () => {
    const scope = await createScope(root);
    expect(scope.root).toBe(root);
  });

  it("resolves a symlinked root to its real location", async () => {
    const alias = path.join(base, "root-alias");
    await symlink(root, alias);
    const scope = await createScope(alias);
    expect(scope.root).toBe(root);
  });

  it("rejects a root that does not exist", async () => {
    await expect(createScope(path.join(base, "nope"))).rejects.toThrow(ScopeError);
  });

  it("rejects a root that is a file", async () => {
    await expect(createScope(path.join(root, "src", "a.ts"))).rejects.toThrow(ScopeError);
  });

  it("rejects a non-string or empty root", async () => {
    await expect(createScope("")).rejects.toThrow(ScopeError);
    await expect(createScope(undefined as unknown as string)).rejects.toThrow(ScopeError);
  });
});

describe("scope.resolve: allowed paths", () => {
  it("accepts the root itself", async () => {
    const scope = await createScope(root);
    expect(await scope.resolve(root)).toBe(root);
    expect(await scope.resolve(".")).toBe(root);
  });

  it("accepts absolute and root-relative paths to existing files", async () => {
    const scope = await createScope(root);
    const file = path.join(root, "src", "a.ts");
    expect(await scope.resolve(file)).toBe(file);
    expect(await scope.resolve("src/a.ts")).toBe(file);
  });

  it("normalises harmless dot segments that stay inside", async () => {
    const scope = await createScope(root);
    expect(await scope.resolve("src/deep/../a.ts")).toBe(path.join(root, "src", "a.ts"));
  });

  it("accepts a path that does not exist yet, under the root", async () => {
    const scope = await createScope(root);
    expect(await scope.resolve("src/new/dir/file.ts")).toBe(
      path.join(root, "src", "new", "dir", "file.ts"),
    );
  });

  it("follows a symlink that stays inside and returns the real path", async () => {
    const scope = await createScope(root);
    expect(await scope.resolve("link-inside/a.ts")).toBe(path.join(root, "src", "a.ts"));
  });
});

describe("scope.resolve: escapes are rejected", () => {
  it.each([
    ["parent traversal", "../secret/key.txt"],
    ["deep traversal", "src/../../secret/key.txt"],
    ["absolute outside path", "/etc/passwd"],
    ["sibling sharing the root name as a prefix", "../project-evil/f.txt"],
    ["symlinked directory pointing outside", "link-outside/key.txt"],
    ["symlinked file pointing outside", "file-link-outside"],
    ["dangling symlink pointing outside", "dangling-outside"],
    ["nonexistent path beneath an outside symlink", "link-outside/new/file.txt"],
  ])("rejects %s", async (_name, input) => {
    const scope = await createScope(root);
    await expect(scope.resolve(input)).rejects.toThrow(ScopeError);
  });

  it("rejects the parent of the root", async () => {
    const scope = await createScope(root);
    await expect(scope.resolve(base)).rejects.toThrow(ScopeError);
  });

  it("rejects paths containing a NUL byte", async () => {
    const scope = await createScope(root);
    await expect(scope.resolve("src/a.ts\0.png")).rejects.toThrow(ScopeError);
  });

  it("rejects empty and non-string input", async () => {
    const scope = await createScope(root);
    await expect(scope.resolve("")).rejects.toThrow(ScopeError);
    await expect(scope.resolve(42 as unknown as string)).rejects.toThrow(ScopeError);
  });

  it("does not leak the attempted outside realpath in the error message", async () => {
    const scope = await createScope(root);
    const err = await scope.resolve("link-outside/key.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect((err as Error).message).not.toContain(outside);
  });
});

describe("scope.contains", () => {
  it("returns true for allowed and false for denied paths, never throwing", async () => {
    const scope = await createScope(root);
    expect(await scope.contains("src/a.ts")).toBe(true);
    expect(await scope.contains("../secret/key.txt")).toBe(false);
    expect(await scope.contains("link-outside/key.txt")).toBe(false);
    expect(await scope.contains("a\0b")).toBe(false);
  });
});

describe("scope include/exclude", () => {
  it("excludes files matched by a pattern, and everything under a matched directory", async () => {
    const scope = await createScope(root, { exclude: ["src/deep", "*.log"], scopeFile: false });
    await expect(scope.resolve("src/deep/x.ts")).rejects.toThrow(/excluded/);
    await expect(scope.resolve("debug.log")).rejects.toThrow(ScopeError);
    expect(await scope.resolve("src/a.ts")).toBe(path.join(root, "src", "a.ts"));
    expect(scope.isExcluded("src/deep")).toBe(true);
    expect(scope.isExcluded("src/a.ts")).toBe(false);
  });

  it("restricts to include patterns when given", async () => {
    const scope = await createScope(root, { include: ["src"], scopeFile: false });
    expect(await scope.contains("src/a.ts")).toBe(true);
    expect(await scope.contains("package.json")).toBe(false);
  });

  it("never excludes the root itself", async () => {
    const scope = await createScope(root, { exclude: ["**"], scopeFile: false });
    expect(await scope.resolve(".")).toBe(root);
  });

  it("applies exclusion after following symlinks", async () => {
    const scope = await createScope(root, { exclude: ["src"], scopeFile: false });
    await expect(scope.resolve("link-inside/a.ts")).rejects.toThrow(ScopeError);
  });

  it("loads .cyberkit/scope.json automatically and merges explicit excludes", async () => {
    await mkdir(path.join(root, ".cyberkit"), { recursive: true });
    await writeFile(path.join(root, ".cyberkit", "scope.json"), JSON.stringify({ version: 1, exclude: ["src/deep"] }));
    try {
      const scope = await createScope(root, { exclude: ["*.md"] });
      expect(scope.exclude).toEqual(["src/deep", "*.md"]);
      expect(await scope.contains("src/deep/x")).toBe(false);
      const ignoring = await createScope(root, { scopeFile: false });
      expect(await ignoring.contains("src/deep/x")).toBe(true);
    } finally {
      await rm(path.join(root, ".cyberkit"), { recursive: true, force: true });
    }
  });

  it("rejects invalid explicit patterns", async () => {
    await expect(createScope(root, { exclude: ["../x"], scopeFile: false })).rejects.toThrow(/pattern/);
  });
});

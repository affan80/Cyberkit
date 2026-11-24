import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/cli/config.js";
import { SCOPE_FILE, ScopeFileError, compileGlob, loadScopeFile, parseScopeConfig } from "../src/scope-file.js";

describe("compileGlob", () => {
  it.each([
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["**/fixtures", "test/fixtures", true],
    ["**/fixtures", "fixtures", true],
    ["dist/**", "dist/a/b.js", true],
    ["dist/**", "dist", true],
    ["dist/", "dist", true],
    ["a?.js", "ab.js", true],
    ["a?.js", "a/.js", false],
    ["file.min.js", "fileXminXjs", false],
    ["(x)+[y]", "(x)+[y]", true],
  ])("%s matches %s -> %s", (pattern, p, expected) => {
    expect(compileGlob(pattern).test(p)).toBe(expected);
  });

  it("is linear on hostile input (no catastrophic backtracking)", () => {
    const re = compileGlob("**/*a*a*a*a*a*b");
    const start = performance.now();
    re.test("a".repeat(5000));
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("parseScopeConfig", () => {
  it("accepts a minimal config", () => {
    expect(parseScopeConfig({ version: 1 })).toEqual({ include: [], exclude: [] });
  });

  it("accepts include, exclude and $schema", () => {
    expect(parseScopeConfig({ $schema: "./scope.schema.json", version: 1, include: ["src"], exclude: ["**/fixtures", "dist/**"] })).toEqual({
      include: ["src"],
      exclude: ["**/fixtures", "dist/**"],
    });
  });

  it.each([
    ["not an object", []],
    ["null", null],
    ["missing version", { exclude: [] }],
    ["wrong version", { version: 2 }],
    ["unknown key (typo)", { version: 1, exlude: ["x"] }],
    ["non-array exclude", { version: 1, exclude: "dist" }],
    ["empty pattern", { version: 1, exclude: [""] }],
    ["absolute pattern", { version: 1, exclude: ["/etc"] }],
    ["parent traversal", { version: 1, include: ["../other"] }],
    ["nested parent traversal", { version: 1, include: ["src/../../x"] }],
    ["backslash", { version: 1, exclude: ["dist\\a"] }],
    ["NUL byte", { version: 1, exclude: ["a\u0000b"] }],
    ["non-string pattern", { version: 1, exclude: [5] }],
    ["too many patterns", { version: 1, exclude: Array.from({ length: 1001 }, (_, i) => `p${i}`) }],
    ["over-long pattern", { version: 1, exclude: ["a".repeat(1025)] }],
  ])("rejects %s", (_n, value) => {
    expect(() => parseScopeConfig(value)).toThrow(ScopeFileError);
  });

  it("ScopeFileError is a ConfigError (CLI exit code 2)", () => {
    expect(new ScopeFileError("x")).toBeInstanceOf(ConfigError);
  });
});

describe("loadScopeFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-scopefile-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const write = async (content: string) => {
    await mkdir(path.join(dir, ".cyberkit"), { recursive: true });
    await writeFile(path.join(dir, SCOPE_FILE), content);
  };

  it("returns an empty config when there is no scope file", async () => {
    expect(await loadScopeFile(dir)).toEqual({ include: [], exclude: [] });
  });

  it("loads and validates the scope file", async () => {
    await write(JSON.stringify({ version: 1, exclude: ["vendor"] }));
    expect(await loadScopeFile(dir)).toEqual({ include: [], exclude: ["vendor"] });
  });

  it("reports invalid JSON with the file name", async () => {
    await write("{ nope");
    await expect(loadScopeFile(dir)).rejects.toThrow(/\.cyberkit\/scope\.json/);
  });

  it("refuses an oversized scope file", async () => {
    await write(JSON.stringify({ version: 1, exclude: Array.from({ length: 1000 }, () => "x".repeat(100)) }));
    await expect(loadScopeFile(dir)).rejects.toThrow(ScopeFileError);
  });

  it("refuses a scope file that is a symlink pointing outside the root", async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-scopefile-out-")));
    try {
      await writeFile(path.join(outside, "scope.json"), JSON.stringify({ version: 1 }));
      await mkdir(path.join(dir, ".cyberkit"));
      await symlink(path.join(outside, "scope.json"), path.join(dir, SCOPE_FILE));
      await expect(loadScopeFile(dir)).rejects.toThrow(ScopeFileError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

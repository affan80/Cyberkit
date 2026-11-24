import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, createScope, parseCliArgs } from "../../src/index.js";

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-cli-")));
  await mkdir(path.join(base, "app", "src"), { recursive: true });
  await writeFile(path.join(base, "app", "src", "a.ts"), "x");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("CLI args -> config -> scope (public API)", () => {
  it("a parsed target becomes a working scope", async () => {
    const r = parseCliArgs(["scan", path.join(base, "app"), "-f", "json", "-p", "semgrep"]);
    expect(r.kind).toBe("run");
    if (r.kind !== "run") return;
    const scope = await createScope(r.config.target);
    expect(await scope.contains("src/a.ts")).toBe(true);
    expect(await scope.contains("../../etc/passwd")).toBe(false);
    expect(r.config).toMatchObject({ format: "json", plugins: ["semgrep"] });
  });

  it("the default target scopes to the current working directory", async () => {
    const r = parseCliArgs(["scan"]);
    if (r.kind !== "run") throw new Error("expected run");
    const scope = await createScope(r.config.target);
    expect(scope.root).toBe(await realpath(process.cwd()));
  });

  it("a non-existent target parses fine but is rejected by scope creation", async () => {
    const r = parseCliArgs(["scan", path.join(base, "missing")]);
    if (r.kind !== "run") throw new Error("expected run");
    await expect(createScope(r.config.target)).rejects.toThrow();
  });

  it("usage errors surface as ConfigError from the public entry point", () => {
    expect(() => parseCliArgs(["scan", "--format", "pdf"])).toThrow(ConfigError);
  });

  it("parsing a realistic CI invocation is fast", () => {
    const start = performance.now();
    for (let i = 0; i < 5000; i++) parseCliArgs(["scan", "./app", "-f", "sarif", "-o", "r.sarif", "-p", "semgrep", "-q"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

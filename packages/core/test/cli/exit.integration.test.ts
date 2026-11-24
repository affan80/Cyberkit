import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, createScope, definePlugin, exitCodeFor, exitCodeForError, parseCliArgs, runPlugin, scanSupplyChain } from "../../src/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-exit-int-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function scanWith(argv: string[], deps: Record<string, string>, plugins: Parameters<typeof definePlugin>[0][] = []) {
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.kind !== "run") throw new Error("expected run");
    const scope = await createScope(parsed.config.target);
    const pluginResults = await Promise.all(plugins.map((p) => runPlugin(definePlugin(p), scope, { timeoutMs: 200 })));
    const findings = [...(await scanSupplyChain(scope)), ...pluginResults.flatMap((r) => r.findings)];
    return exitCodeFor({ findings, failOn: parsed.config.failOn, plugins: pluginResults });
  } catch (e) {
    return exitCodeForError(e);
  }
}

describe("CLI args -> scan -> exit code (public API)", () => {
  it("0 for a clean project", async () => {
    expect(await scanWith(["scan", dir], { react: "^18.0.0" })).toBe(EXIT.OK);
  });

  it("1 when a finding meets the default threshold", async () => {
    expect(await scanWith(["scan", dir], { left: "*" })).toBe(EXIT.FINDINGS);
  });

  it("0 when the same finding is below --fail-on high", async () => {
    expect(await scanWith(["scan", dir, "--fail-on", "high"], { left: "*" })).toBe(EXIT.OK);
  });

  it("1 for a high-severity typosquat with --fail-on high", async () => {
    expect(await scanWith(["scan", dir, "--fail-on", "high"], { l0dash: "1.0.0" })).toBe(EXIT.FINDINGS);
  });

  it("2 for bad arguments", async () => {
    expect(await scanWith(["scan", "--fail-on", "sometimes"], {})).toBe(EXIT.USAGE);
  });

  it("3 when the target does not exist", async () => {
    expect(await scanWith(["scan", path.join(dir, "missing")], {})).toBe(EXIT.SCAN_ERROR);
  });

  it("4 when a plugin hangs or crashes and nothing crosses the threshold", async () => {
    const hang = { name: "hang", run: () => new Promise<never>(() => {}) };
    expect(await scanWith(["scan", dir], { react: "^18.0.0" }, [hang])).toBe(EXIT.PARTIAL);
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlugin } from "../../src/plugins/base.js";
import { createSemgrepPlugin, mapSemgrepOutput, semgrepArgs } from "../../src/plugins/semgrep.js";
import { createScope } from "../../src/scope.js";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/bin/fake-semgrep.mjs");

describe("mapSemgrepOutput", () => {
  const result = (severity: string) => ({ check_id: "r.x", path: "/p/a.js", start: { line: 4 }, extra: { message: "msg", severity, lines: "code" } });

  it("maps a semgrep result to plugin finding input", () => {
    expect(mapSemgrepOutput({ results: [result("ERROR")] })).toEqual([
      { ruleId: "r.x", severity: "high", message: "msg", file: "/p/a.js", line: 4, evidence: "code" },
    ]);
  });

  it.each([
    ["CRITICAL", "critical"], ["ERROR", "high"], ["HIGH", "high"], ["WARNING", "medium"],
    ["MEDIUM", "medium"], ["INFO", "low"], ["LOW", "low"], ["EXPERIMENT", "info"], [undefined, "info"],
  ])("maps severity %s to %s", (input, expected) => {
    expect(mapSemgrepOutput({ results: [result(input as string)] })[0]?.severity).toBe(expected);
  });

  it("drops results without a rule id and tolerates missing optional fields", () => {
    const out = mapSemgrepOutput({ results: [{ path: "a" }, { check_id: "r", extra: {} }, null] });
    expect(out).toEqual([{ ruleId: "r", severity: "info", message: "r", file: undefined, line: undefined, evidence: undefined }]);
  });

  it.each([null, "x", { results: "nope" }, {}])("throws on malformed output %j", (value) => {
    expect(() => mapSemgrepOutput(value)).toThrow(/semgrep/i);
  });
});

describe("semgrepArgs", () => {
  it("always disables metrics and version checks (offline-first) and never uses a shell", () => {
    const args = semgrepArgs(["/r/.semgrep.yml"], "/r");
    expect(args).toEqual(["scan", "--json", "--quiet", "--metrics=off", "--disable-version-check", "--config", "/r/.semgrep.yml", "/r"]);
  });

  it("passes every config", () => {
    expect(semgrepArgs(["a.yml", "b.yml"], "/r").filter((a) => a === "--config")).toHaveLength(2);
  });
});

describe("semgrep plugin (fake semgrep binary)", () => {
  let dir: string;
  let argsFile: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-semgrep-")));
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "a.js"), "x");
    await writeFile(path.join(dir, ".semgrep.yml"), "rules: []\n");
    argsFile = path.join(dir, "args.log");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (mode: string, opts: Parameters<typeof createSemgrepPlugin>[0] = {}, timeoutMs?: number) =>
    runPlugin(
      createSemgrepPlugin({ binary: FAKE, env: { FAKE_SEMGREP_MODE: mode, FAKE_SEMGREP_ARGS_FILE: argsFile, PATH: process.env.PATH ?? "" }, ...opts }),
      await createScope(dir),
      timeoutMs === undefined ? {} : { timeoutMs },
    );

  it("maps results to redacted, root-relative findings", async () => {
    const res = await run("results");
    expect(res.status).toBe("ok");
    expect(res.findings.map((f) => [f.engine, f.ruleId, f.severity, f.file, f.line])).toEqual([
      ["plugin:semgrep", "rules.sql-injection", "high", "src/a.js", 3],
      ["plugin:semgrep", "rules.hardcoded-secret", "medium", "src/a.js", 7],
    ]);
    expect(JSON.stringify(res.findings)).not.toContain("hunter2");
  });

  it("uses the local .semgrep.yml in the scan root and offline flags", async () => {
    await run("empty");
    const args = JSON.parse((await readFile(argsFile, "utf8")).trim()) as string[];
    expect(args).toContain("--metrics=off");
    expect(args).toContain("--disable-version-check");
    expect(args[args.indexOf("--config") + 1]).toBe(path.join(dir, ".semgrep.yml"));
    expect(args.at(-1)).toBe(dir);
  });

  it("falls back to a .semgrep/ directory config", async () => {
    await rm(path.join(dir, ".semgrep.yml"));
    await mkdir(path.join(dir, ".semgrep"));
    await run("empty");
    const args = JSON.parse((await readFile(argsFile, "utf8")).trim()) as string[];
    expect(args[args.indexOf("--config") + 1]).toBe(path.join(dir, ".semgrep"));
  });

  it("uses explicit configs when given", async () => {
    await run("empty", { configs: ["custom.yml"] });
    const args = JSON.parse((await readFile(argsFile, "utf8")).trim()) as string[];
    expect(args[args.indexOf("--config") + 1]).toBe(path.join(dir, "custom.yml"));
  });

  it.each(["auto", "p/default", "r/python.lang", "https://example.com/rules.yml"])("refuses network config %s", async (config) => {
    const res = await run("empty", { configs: [config] });
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/network|local/i);
  });

  it("errors clearly when there is no local config", async () => {
    await rm(path.join(dir, ".semgrep.yml"));
    const res = await run("empty");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/no local semgrep config/i);
  });

  it("errors clearly when semgrep is not installed", async () => {
    const res = await run("empty", { binary: path.join(dir, "no-such-semgrep") });
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/not installed|not found/i);
  });

  it.runIf(process.platform !== "win32")("never runs a repo-supplied ./semgrep via '.' or an empty PATH entry (issue #47)", async () => {
    const pwned = path.join(dir, "PWNED");
    await writeFile(path.join(dir, "semgrep"), `#!/bin/sh\ntouch "${pwned}"\necho '{"results":[]}'\n`, { mode: 0o755 });
    for (const PATH of ["/usr/bin:/bin:", ":/usr/bin:/bin", "/usr/bin::/bin", ".:/usr/bin:/bin"]) {
      const res = await runPlugin(createSemgrepPlugin({ env: { PATH } }), await createScope(dir));
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/not installed/);
    }
    await expect(readFile(pwned)).rejects.toThrow();
  });

  it("runs semgrep with a cwd outside the scanned tree, passing the target explicitly", async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-semgrep-cwd-")));
    try {
      const cwdFile = path.join(outside, "cwd.txt");
      const res = await run("results", { env: { FAKE_SEMGREP_MODE: "results", FAKE_SEMGREP_CWD_FILE: cwdFile, PATH: process.env.PATH ?? "" } });
      expect(res.status).toBe("ok");
      const cwd = await realpath(await readFile(cwdFile, "utf8"));
      expect(path.relative(dir, cwd).startsWith("..")).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a failing semgrep run with redacted stderr", async () => {
    const res = await run("fail");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/exit.*2/);
    expect(res.error).not.toContain("abc123");
  });

  it("reports unparseable output as an error", async () => {
    expect((await run("garbage")).status).toBe("error");
  });

  it("kills a hung semgrep when the scan times out", async () => {
    const start = performance.now();
    const res = await run("hang", {}, 500);
    expect(res.status).toBe("timeout");
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("stops reading and fails when output exceeds the cap", async () => {
    const res = await run("flood", { maxOutputBytes: 1024 * 1024 });
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/output/i);
  });
});

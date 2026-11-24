import { access, constants, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { type CliIO, main } from "../../src/cli/main.js";
import { HELP_TEXT } from "../../src/cli/parse.js";
import { VERSION } from "../../src/version.js";

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function io(opts: { isTTY?: boolean; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIO = {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    isTTY: opts.isTTY ?? false,
    env: opts.env ?? {},
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-main-")));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const project = (deps: Record<string, string>) => writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }, null, 2));

describe("main(): help and version", () => {
  it("prints help with no arguments and exits 0", async () => {
    const t = io();
    expect(await main([], t.io)).toBe(EXIT.OK);
    expect(t.out()).toBe(HELP_TEXT);
  });

  it("prints the version", async () => {
    const t = io();
    expect(await main(["--version"], t.io)).toBe(EXIT.OK);
    expect(t.out()).toBe(`${VERSION}\n`);
  });
});

describe("main(): scanning", () => {
  it("exits 0 and reports no findings for a clean project", async () => {
    await project({ react: "^18.0.0" });
    const t = io();
    expect(await main(["scan", dir], t.io)).toBe(EXIT.OK);
    expect(t.out()).toBe("CyberKit: no findings\n");
  });

  it("exits 1 and prints the plain report when findings meet the threshold", async () => {
    await project({ left: "*" });
    const t = io();
    expect(await main(["scan", dir], t.io)).toBe(EXIT.FINDINGS);
    expect(t.out()).toContain("supply-chain/wildcard-version");
  });

  it("respects --fail-on", async () => {
    await project({ left: "*" });
    expect(await main(["scan", dir, "--fail-on", "high"], io().io)).toBe(EXIT.OK);
  });

  it.each([
    ["json", (s: string) => expect((JSON.parse(s) as { summary: { total: number } }).summary.total).toBe(1)],
    ["sarif", (s: string) => expect((JSON.parse(s) as { version: string }).version).toBe("2.1.0")],
  ])("writes %s to stdout", async (format, check) => {
    await project({ left: "*" });
    const t = io();
    await main(["scan", dir, "-f", format], t.io);
    check(t.out());
  });

  it("writes the report to --output (creating directories) and nothing to stdout", async () => {
    await project({ left: "*" });
    const t = io();
    const file = path.join(dir, "reports", "out.sarif");
    expect(await main(["scan", dir, "-f", "sarif", "-o", file], t.io)).toBe(EXIT.FINDINGS);
    expect(t.out()).toBe("");
    expect((JSON.parse(await readFile(file, "utf8")) as { version: string }).version).toBe("2.1.0");
  });

  it("colours the text report only on a TTY without NO_COLOR", async () => {
    await project({ left: "*" });
    const tty = io({ isTTY: true });
    await main(["scan", dir], tty.io);
    expect(tty.out()).toContain("\u001b[");

    const noColor = io({ isTTY: true, env: { NO_COLOR: "1" } });
    await main(["scan", dir], noColor.io);
    expect(noColor.out()).not.toContain("\u001b[");

    const pipe = io({ isTTY: false });
    await main(["scan", dir], pipe.io);
    expect(pipe.out()).not.toContain("\u001b[");
  });

  it("never colours json or sarif output", async () => {
    await project({ left: "*" });
    const t = io({ isTTY: true });
    await main(["scan", dir, "-f", "json"], t.io);
    expect(t.out()).not.toContain("\u001b[");
  });

  it("warns on stderr about failed plugins and exits 4 when nothing crosses the threshold", async () => {
    await project({});
    const t = io();
    expect(await main(["scan", dir, "-p", "semgrep"], t.io)).toBe(EXIT.PARTIAL);
    expect(t.err()).toMatch(/plugin semgrep: error/);
  });

  it("--quiet suppresses the plugin warnings but keeps the exit code", async () => {
    await project({});
    const t = io();
    expect(await main(["scan", dir, "-p", "semgrep", "-q"], t.io)).toBe(EXIT.PARTIAL);
    expect(t.err()).toBe("");
  });
});

describe("main(): errors", () => {
  it("exits 2 with a usage hint for bad arguments", async () => {
    const t = io();
    expect(await main(["scan", "--format", "pdf"], t.io)).toBe(EXIT.USAGE);
    expect(t.err()).toMatch(/^cyberkit: .*text, json, sarif/);
    expect(t.err()).toContain("cyberkit --help");
    expect(t.out()).toBe("");
  });

  it("exits 2 for an unknown plugin", async () => {
    expect(await main(["scan", dir, "-p", "nope"], io().io)).toBe(EXIT.USAGE);
  });

  it("exits 3 for a missing target", async () => {
    const t = io();
    expect(await main(["scan", path.join(dir, "missing")], t.io)).toBe(EXIT.SCAN_ERROR);
    expect(t.err()).toMatch(/^cyberkit: /);
  });

  it("exits 3 when the output file cannot be written", async () => {
    await project({});
    await mkdir(path.join(dir, "blocked"));
    await writeFile(path.join(dir, "blocked", "file"), "x");
    const t = io();
    expect(await main(["scan", dir, "-o", path.join(dir, "blocked", "file", "out.txt")], t.io)).toBe(EXIT.SCAN_ERROR);
  });
});

describe("bin/cyberkit", () => {
  it("exists, is executable, has a node shebang and is declared in package.json", async () => {
    const bin = path.join(PKG_DIR, "bin", "cyberkit");
    await access(bin, constants.X_OK);
    expect((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    const pkg = JSON.parse(await readFile(path.join(PKG_DIR, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[] };
    expect(pkg.bin).toEqual({ cyberkit: "bin/cyberkit" });
    expect(pkg.files).toContain("bin");
  });
});

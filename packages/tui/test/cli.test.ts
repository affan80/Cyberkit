import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TuiCliIO, main } from "../src/cli.js";
import { stripAnsi } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "ck-tui-cli-")));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", left: "*" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function io(opts: { tty?: boolean; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: TuiCliIO = {
    stdin: { isTTY: opts.tty ?? false } as never,
    stdout: { isTTY: opts.tty ?? false, columns: 100, rows: 30, write: (s: string) => void out.push(s) } as never,
    stderr: { write: (s: string) => void err.push(s) },
    env: opts.env ?? {},
    cwd: dir,
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

describe("cyberkit-tui main()", () => {
  it("prints help and version", async () => {
    const h = io();
    expect(await main(["--help"], h.io)).toBe(0);
    expect(h.out()).toMatch(/Usage: cyberkit-tui \[target\]/);
    expect(h.out()).toContain("--frame");
    const v = io();
    expect(await main(["--version"], v.io)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("refuses to start interactively without a terminal", async () => {
    const t = io({ tty: false });
    expect(await main([dir], t.io)).toBe(2);
    expect(t.err()).toMatch(/needs an interactive terminal.*--frame/);
  });

  it("--frame runs a real scan and prints one frame of exactly the requested size", async () => {
    const t = io();
    expect(await main([dir, "--frame", "--cols", "120", "--rows", "32"], t.io)).toBe(1);
    const lines = t.out().replace(/\n$/, "").split("\n");
    expect(lines).toHaveLength(32);
    for (const l of lines) expect([...stripAnsi(l)].length).toBe(120);
    expect(t.out()).toContain("possible-typosquat");
    expect(t.out()).not.toContain("\u001b[");
  });

  it("--keys replays keystrokes before the frame is drawn", async () => {
    const t = io();
    await main([dir, "--frame", "--keys", "s"], t.io);
    expect(t.out()).toContain("[4] Findings 0 · critical");
  });

  it("--fail-on changes the exit code", async () => {
    expect(await main([dir, "--frame", "--fail-on", "high"], io().io)).toBe(0);
  });

  it("colours the frame with FORCE_COLOR and never with NO_COLOR", async () => {
    const c = io({ env: { FORCE_COLOR: "1" } });
    await main([dir, "--frame"], c.io);
    expect(c.out()).toContain("\u001b[");
    const n = io({ env: { FORCE_COLOR: "1", NO_COLOR: "1" } });
    await main([dir, "--frame"], n.io);
    expect(n.out()).not.toContain("\u001b[");
  });

  it("exits 3 with the error in the frame for a missing target", async () => {
    const t = io();
    expect(await main([path.join(dir, "nope"), "--frame"], t.io)).toBe(3);
    expect(t.out()).toContain("Scan failed");
  });

  it.each([
    [["--nope"]],
    [["a", "b", "--frame"]],
    [["--fail-on", "sometimes", "--frame"]],
    [["-p", "nope", "--frame"]],
    [["--frame", "--cols", "abc"]],
  ])("exits 2 with a usage hint for %j", async (argv) => {
    const t = io();
    expect(await main(argv, t.io)).toBe(2);
    expect(t.err()).toMatch(/^cyberkit-tui: /);
  });
});

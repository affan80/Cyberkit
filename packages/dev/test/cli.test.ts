import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "@cyberkit/core";
import { type DevCliIO, HELP_TEXT, main } from "../src/cli.js";
import { fakeTerminal, fixtureRepo, NODE_SCRIPTS, stripAnsi } from "./helpers.js";

let root: string;
beforeEach(async () => {
  root = await fixtureRepo({ lint: NODE_SCRIPTS.pass, typecheck: NODE_SCRIPTS.tsError, build: NODE_SCRIPTS.pass, test: NODE_SCRIPTS.pass });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function io(opts: { tty?: boolean; env?: Record<string, string> } = {}) {
  const t = fakeTerminal(100, 30);
  const out: string[] = [];
  const err: string[] = [];
  const value: DevCliIO = {
    stdin: { ...t.stdin, isTTY: opts.tty ?? false },
    stdout: { ...t.stdout, isTTY: opts.tty ?? false, write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: opts.env ?? {},
    cwd: root,
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

describe("cyberkit-dev cli", () => {
  it("prints help and version; rejects bad flags and stray arguments with exit 2", async () => {
    let t = io();
    expect(await main(["--help"], t.io)).toBe(0);
    expect(t.out()).toBe(HELP_TEXT);
    t = io();
    expect(await main(["-v"], t.io)).toBe(0);
    expect(t.out()).toBe(`${VERSION}\n`);
    for (const bad of [["--nope"], ["stray"], ["--frame", "--cols", "0"]]) {
      t = io();
      expect(await main(bad, t.io)).toBe(2);
      expect(t.err()).toContain('Run "cyberkit-dev --help" for usage.');
    }
  });

  it("refuses to start the UI without a terminal", async () => {
    const t = io();
    expect(await main([], t.io)).toBe(2);
    expect(t.err()).toMatch(/needs an interactive terminal/);
  });

  it("--list prints the commands by group", async () => {
    const t = io();
    expect(await main(["--list"], t.io)).toBe(0);
    expect(t.out()).toMatch(/^checks\n {2}chain:verify\s+lint → typecheck → build → test\n\nroot\n {2}root:lint/);
  });

  it("--run streams output, prints the error log and exits with the command's code; --errors and --history read it back", async () => {
    const cache = path.join(root, "cache");
    let t = io();
    expect(await main(["--run", "root:typecheck", "--cache-dir", cache], t.io)).toBe(2);
    expect(t.out()).toContain("compiling");
    expect(t.out()).toContain("── error log: typecheck (1) ──\ntypescript  src/a.ts:3:5  TS2322  Type string is not assignable to type number.");
    expect(t.out()).toMatch(/✗ typecheck failed in .* · log: .*\.log\n$/);

    t = io();
    expect(await main(["--run", "chain:verify", "--cache-dir", cache], t.io)).toBe(2);
    expect(t.out()).toContain("» ▶ lint:");
    expect(t.out()).toContain("» ▶ typecheck:");
    expect(t.out()).not.toContain("» ▶ build:");

    t = io();
    expect(await main(["--errors", "--cache-dir", cache], t.io)).toBe(0);
    expect(t.out()).toMatch(/── error log: verify · failed · .* \(1\) ──\ntypescript {2}src\/a\.ts:3:5/);

    t = io();
    expect(await main(["--history", "--cache-dir", cache], t.io)).toBe(0);
    expect(t.out().trim().split("\n")).toHaveLength(2);
    expect(t.out()).toMatch(/^✗ .* {2}verify {2}.* {2}1 error {2}\S+\n✗ .* {2}typecheck/);

    t = io();
    expect(await main(["--errors", "nope", "--cache-dir", cache], t.io)).toBe(2);
    expect(t.err()).toContain('no run "nope" in the history');

    t = io();
    expect(await main(["--run", "root:lint", "--cache-dir", cache], t.io)).toBe(0);

    t = io();
    expect(await main(["--clear-history", "--cache-dir", cache], t.io)).toBe(0);
    t = io();
    expect(await main(["--history", "--cache-dir", cache], t.io)).toBe(0);
    expect(t.out()).toBe("no runs yet\n");
  }, 60_000);

  it("--run rejects an unknown command", async () => {
    const t = io();
    expect(await main(["--run", "root:nope"], t.io)).toBe(2);
    expect(t.err()).toContain('unknown command "root:nope" (see --list)');
  });

  it("--frame draws one frame of the requested size and never runs commands", async () => {
    const cache = path.join(root, "cache");
    const t = io();
    expect(await main(["--frame", "--cols", "90", "--rows", "20", "--keys", "j\ra", "--cache-dir", cache], t.io)).toBe(0);
    const lines = t.out().replace(/\n$/, "").split("\n");
    expect(lines).toHaveLength(20);
    for (const l of lines) expect([...stripAnsi(l)]).toHaveLength(90);
    expect(t.out()).toContain("idle · 0 runs");
    const h = io();
    await main(["--history", "--cache-dir", cache], h.io);
    expect(h.out()).toBe("no runs yet\n");
  });

  it("--frame can show a cached run's log and error log", async () => {
    const cache = path.join(root, "cache");
    await main(["--run", "root:typecheck", "--cache-dir", cache], io().io);
    const t = io();
    expect(await main(["--frame", "--keys", "2\r", "--cache-dir", cache], t.io)).toBe(0);
    expect(t.out()).toContain("compiling");
    expect(t.out()).toContain("4 Errors (1) · typecheck");
    expect(t.out()).not.toContain("(loading)");
  }, 30_000);

  it("colours the frame only when asked", async () => {
    let t = io({ env: { FORCE_COLOR: "1" } });
    await main(["--frame"], t.io);
    expect(t.out()).toContain("\u001b[");
    t = io({ tty: true, env: { NO_COLOR: "1" } });
    await main(["--frame"], t.io);
    expect(t.out()).not.toContain("\u001b[");
  });
});

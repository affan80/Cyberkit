import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_TERMINATED, runApp } from "../src/app.js";
import { loadHistory } from "../src/history.js";
import { initialState } from "../src/state.js";
import type { CommandSpec } from "../src/types.js";
import { fakeTerminal, until } from "./helpers.js";

const NODE = process.execPath;
const node = (id: string, code: string): CommandSpec => ({ id, group: "root", name: id.split(":")[1] ?? id, description: code, argv: [NODE, "-e", code], cwd: process.cwd() });
const COMMANDS = [
  node("root:fail", "console.log('compiling'); console.log('src/a.ts(3,5): error TS2322: bad type'); process.exit(2)"),
  node("root:slow", "console.log('started'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
  node("root:spam", "for (let i = 0; i < 5000; i++) console.log('line ' + i)"),
];
const ENTER = "\u001b[?1049h";
const LEAVE = "\u001b[?1049l";

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "cyberkit-dev-app-"));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const start = (t: ReturnType<typeof fakeTerminal>, extra: Partial<Parameters<typeof runApp>[0]> = {}) =>
  runApp({ state: initialState("fixture", COMMANDS), cacheDir, color: false, killGraceMs: 300, ...extra }, { stdin: t.stdin, stdout: t.stdout });

describe("runApp", () => {
  it("takes over the terminal and restores it on quit", async () => {
    const t = fakeTerminal();
    const done = start(t);
    expect(t.output()).toContain(ENTER);
    expect(t.state.raw).toBe(true);
    expect(t.screen()).toContain("1 Commands");
    t.type("q");
    expect(await done).toBe(0);
    expect(t.output().endsWith(`\u001b[?25h${LEAVE}`)).toBe(true);
    expect(t.state).toMatchObject({ raw: false, paused: true });
  });

  it("runs a command from the keyboard, shows its output and error log, and caches it", async () => {
    const t = fakeTerminal();
    const done = start(t);
    t.type("\r");
    await until(() => t.screen().includes("4 Errors (1)"), 10_000, "the run to finish");
    const screen = t.screen();
    expect(screen).toContain("compiling");
    expect(screen).toContain("typescript  src/a.ts:3:5  TS2322  bad type");
    expect(screen).toMatch(/✗ \d\d:\d\d:\d\d fail/);
    let history: Awaited<ReturnType<typeof loadHistory>> = [];
    await until(() => (void loadHistory(cacheDir).then((h) => (history = h)), history.length === 1), 5000, "history to be saved");
    expect(history[0]).toMatchObject({ commandId: "root:fail", status: "failed", exitCode: 2, errorCount: 1 });
    expect(history[0]?.logFile).toBeTruthy();
    t.type("q");
    expect(await done).toBe(0);
  });

  it("batches output per frame instead of redrawing per line", async () => {
    const t = fakeTerminal();
    const done = start(t);
    t.type("jj\r");
    await until(() => t.screen().includes("✓ passed"), 10_000, "spam to finish");
    expect(t.screen()).toContain("line 4999");
    expect(t.writes.filter((w) => w.startsWith("\u001b[H")).length).toBeLessThan(500);
    t.type("q");
    await done;
  });

  it("x cancels the running command, killing it even if it ignores SIGTERM", async () => {
    const t = fakeTerminal();
    const done = start(t);
    t.type("j\r");
    await until(() => t.screen().includes("started"), 10_000, "slow to start");
    t.type("x");
    await until(() => t.screen().includes("· cancelled ·"), 10_000, "cancel");
    t.type("q");
    expect(await done).toBe(0);
  });

  it("asks before quitting while a command runs, then cancels it before resolving", async () => {
    const t = fakeTerminal();
    const done = start(t);
    t.type("j\r");
    await until(() => t.screen().includes("started"), 10_000, "slow to start");
    t.type("q");
    expect(t.screen()).toContain("Quit and cancel it? (y/n)");
    t.type("n");
    expect(t.screen()).not.toContain("Quit and cancel it?");
    t.type("q");
    t.type("y");
    expect(await done).toBe(0);
    expect(t.output().endsWith(LEAVE)).toBe(true);
  });

  it("ends with 143 when aborted and restores the terminal", async () => {
    const t = fakeTerminal();
    const ac = new AbortController();
    const done = start(t, { signal: ac.signal });
    ac.abort();
    expect(await done).toBe(EXIT_TERMINATED);
    expect(t.state.raw).toBe(false);
  });

  it("restores the terminal when drawing throws", async () => {
    const t = fakeTerminal();
    Object.defineProperty(t.stdout, "columns", { get: () => { throw new Error("boom"); } });
    await expect(start(t)).rejects.toThrow("boom");
    expect(t.output()).toContain(LEAVE);
    expect(t.state.raw).toBe(false);
  });

  it("redraws on resize", async () => {
    const t = fakeTerminal(100, 30);
    const done = start(t);
    t.stdout.columns = 120;
    t.resize();
    expect(t.screen().split("\n")[0]).toHaveLength(120);
    t.type("q");
    await done;
  });
});

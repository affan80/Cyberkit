import { describe, expect, it } from "vitest";
import { type Action, type DevState, KEY_HELP, initialState, update } from "../src/state.js";
import type { CommandSpec, LogLine } from "../src/types.js";
import { MIN_COLS, MIN_ROWS, formatDuration, layout, render } from "../src/view.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const cmd = (id: string, group = "root"): CommandSpec => ({ id, group, name: id.split(":")[1] ?? id, description: id, argv: ["npm"], cwd: "/repo" });
const COMMANDS = [cmd("chain:verify", "checks"), cmd("root:lint"), cmd("root:test"), cmd("core:test", "core")];
const apply = (s: DevState, ...a: Action[]): DevState => a.reduce(update, s);
const NOW = Date.parse("2026-11-27T04:00:10.000Z");
const start = (runId: string, commandId: string, label = commandId): Action => ({ type: "run-events", events: [{ type: "start", runId, commandId, label, startedAt: "2026-11-27T04:00:00.000Z" }] });
const out = (runId: string, ls: LogLine[]): Action => ({ type: "run-events", events: [{ type: "lines", runId, lines: ls }] });
const exit = (runId: string, code: number): Action => ({ type: "run-events", events: [{ type: "exit", runId, status: code === 0 ? "passed" : "failed", exitCode: code, signal: null, durationMs: 8100 }] });
const frame = (s: DevState, cols = 100, rows = 30, color = false) => render(apply(s, { type: "viewport", outputRows: layout(cols, rows).outputRows }), { cols, rows, color, now: NOW });

const sample = (): DevState =>
  apply(
    initialState("cyberkit", COMMANDS),
    start("r1", "root:lint", "lint"),
    out("r1", [{ stream: "stdout", text: "/repo/a.js" }, { stream: "stdout", text: "  1:2  error  'x' is not defined  no-undef" }, { stream: "stderr", text: "npm error Lifecycle script `lint` failed with error:" }]),
    exit("r1", 1),
    start("r2", "core:test", "core › test"),
    out("r2", Array.from({ length: 50 }, (_, i) => ({ stream: "stdout" as const, text: `test line ${i}` }))),
  );

describe("render", () => {
  it.each([[70, 18], [100, 30], [200, 60]])("draws exactly %ix%i cells", (cols, rows) => {
    for (const color of [false, true]) {
      const lines = frame(sample(), cols, rows, color).split("\n");
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect([...stripAnsi(l)]).toHaveLength(cols);
    }
  });

  it("shows a message when the terminal is too small", () => {
    const f = render(sample(), { cols: MIN_COLS - 1, rows: MIN_ROWS, color: false });
    expect(f).toContain("Terminal too small (need 70×18)");
    expect(f.split("\n")).toHaveLength(MIN_ROWS);
  });

  it("uses no escape sequences without colour, and the focus style with it", () => {
    expect(frame(sample())).not.toContain("\u001b");
    expect(frame(sample(), 100, 30, true)).toContain("\u001b[1;32m┌─");
  });

  it("draws the panes, groups, statuses and the running title", () => {
    const f = frame(sample());
    for (const text of ["1 Commands", "2 Runs", "3 Output · core › test · running · 50 lines · follow", "4 Errors (0) · core › test", "checks", "▶ verify", "core", "running core › test  10.0s"]) expect(f).toContain(text);
    expect(f).toMatch(/lint\s+✗ 8\.1s/);
    expect(f).toMatch(/✗ \d\d:\d\d:\d\d lint {2}8\.1s {2}2 err/);
    expect(f).toContain("test line 49");
    expect(f).not.toContain("test line 10 ");
    expect(f.indexOf("core › test  10.0s")).toBeLessThan(f.indexOf("lint  8.1s"));
  });

  it("shows the errors of the shown run and honours scrolling, errors-only and the filter", () => {
    let s = apply(sample(), { type: "key", key: "2" }, { type: "key", key: "j" }, { type: "key", key: "enter" });
    let f = frame(s);
    expect(f).toContain("4 Errors (2) · lint");
    expect(f).toContain("eslint  /repo/a.js:1:2  no-undef  'x' is not defined");
    expect(f).toContain("npm  Lifecycle script `lint` failed with error:");
    s = apply(s, { type: "key", key: "e" });
    expect(frame(s)).toContain("errors only");
    s = apply(sample(), { type: "key", key: "3" }, { type: "key", key: "g" });
    f = frame(s);
    expect(f).toContain("test line 0");
    expect(f).toMatch(/· 1-\d+/);
    s = apply(s, { type: "key", key: "/" }, ...[..."line 7"].map((key) => ({ type: "key", key }) as Action));
    f = frame(s);
    expect(f).toContain("/line 7▏");
    expect(f).toContain("/line 7");
  });

  it("never lets hostile strings reach the frame unescaped", () => {
    const hostile = initialState("repo\u001b[2J", [{ ...cmd("root:x"), name: "x\u0007\u001b[31m" }]);
    const s = apply(hostile, start("r", "root:x", "lbl\u001b]0;pwn\u0007"), out("r", [{ stream: "stdout", text: "\u001b[2Jclear" }]));
    const f = frame(s, 100, 30, true);
    // eslint-disable-next-line no-control-regex
    const withoutOurStyles = f.replace(/\u001b\[[0-9;]*m/g, "");
    // eslint-disable-next-line no-control-regex
    expect(withoutOurStyles).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });

  it("draws the help overlay and the prompts", () => {
    const help = frame(apply(sample(), { type: "key", key: "?" }));
    for (const [k] of KEY_HELP) expect(help).toContain(k);
    expect(frame(apply(sample(), { type: "key", key: "q" }))).toContain("A command is running. Quit and cancel it? (y/n)");
    expect(frame(apply(sample(), { type: "key", key: "x" }))).toContain("x cancel");
  });

  it("matches the Output pane height to layout().outputRows", () => {
    const { outputRows, panes } = layout(100, 30);
    expect(outputRows).toBe(panes.output.h - 2);
    const f = frame(apply(initialState("r", COMMANDS), start("r1", "root:test"), out("r1", Array.from({ length: 200 }, (_, i) => ({ stream: "stdout" as const, text: `L${i}` })))));
    const shown = f.split("\n").filter((l) => /│ L\d+/.test(l));
    expect(shown).toHaveLength(outputRows);
  });
});

describe("formatDuration", () => {
  it("formats milliseconds, seconds and minutes", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(8100)).toBe("8.1s");
    expect(formatDuration(62_000)).toBe("1m02s");
  });
});

import { describe, expect, it } from "vitest";
import { type Action, type DevState, KEY_HELP, initialState, lastRunOf, outputLines, update, viewRun } from "../src/state.js";
import { type CommandSpec, type LogLine, MAX_MEMORY_LINES, type RunRecord } from "../src/types.js";

const cmd = (id: string, group = "root"): CommandSpec => ({ id, group, name: id.split(":")[1] ?? id, description: id, argv: ["npm", "run", id], cwd: "/repo" });
const COMMANDS = [cmd("chain:verify", "checks"), cmd("root:lint"), cmd("root:test"), cmd("core:test", "core")];
const apply = (s: DevState, ...actions: Action[]): DevState => actions.reduce(update, s);
const keys = (s: DevState, ...ks: string[]): DevState => ks.reduce((st, key) => update(update(st, { type: "key", key }), { type: "command-done" }), s);
const lines = (n: number, prefix = "line"): LogLine[] => Array.from({ length: n }, (_, i) => ({ stream: "stdout", text: `${prefix} ${i}` }));
const start = (runId = "r1", commandId = "root:lint"): Action => ({ type: "run-events", events: [{ type: "start", runId, commandId, label: commandId, startedAt: "2026-11-27T04:00:00.000Z" }] });
const out = (runId: string, ls: LogLine[]): Action => ({ type: "run-events", events: [{ type: "lines", runId, lines: ls }] });
const exit = (runId: string, code: number, status: "passed" | "failed" | "cancelled" = code === 0 ? "passed" : "failed"): Action => ({ type: "run-events", events: [{ type: "exit", runId, status, exitCode: code, signal: null, durationMs: 1500 }] });
const base = () => apply(initialState("cyberkit", COMMANDS), { type: "viewport", outputRows: 5 });

describe("runs", () => {
  it("start, lines and exit build a run and extract its errors", () => {
    let s = apply(base(), start(), out("r1", [{ stream: "stdout", text: "checking" }, { stream: "stdout", text: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'." }]));
    expect(s.activeRunId).toBe("r1");
    expect(viewRun(s)).toMatchObject({ status: "running", lines: [{ text: "checking" }, {}] });
    s = apply(s, exit("r1", 2));
    expect(s.activeRunId).toBeUndefined();
    expect(viewRun(s)).toMatchObject({ status: "failed", exitCode: 2, durationMs: 1500 });
    expect(viewRun(s)?.errors).toMatchObject([{ kind: "typescript", file: "src/a.ts", line: 3, col: 5, lineIndex: 1 }]);
    expect(lastRunOf(s, "root:lint")?.id).toBe("r1");
  });

  it("caps lines in memory and counts what was dropped", () => {
    let s = apply(base(), start());
    for (let i = 0; i < 3; i++) s = apply(s, out("r1", lines(MAX_MEMORY_LINES / 2, `b${i}`)));
    const run = viewRun(s) as RunRecord;
    expect(run.lines).toHaveLength(MAX_MEMORY_LINES);
    expect(run.droppedLines).toBe(MAX_MEMORY_LINES / 2);
    expect(run.lines[0]?.text).toBe("b1 0");
  });

  it("appends large outputs quickly", () => {
    let s = apply(base(), start());
    const batch = lines(1000);
    const t = performance.now();
    for (let i = 0; i < 200; i++) s = apply(s, out("r1", batch));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(viewRun(s)?.lines.length).toBe(MAX_MEMORY_LINES);
  });

  it("merges history without duplicates and loads logs", () => {
    const hist: RunRecord = { id: "old", commandId: "root:test", label: "test", status: "failed", startedAt: "2026-11-26T00:00:00.000Z", durationMs: 5, exitCode: 1, signal: null, lines: [], droppedLines: 0, errors: [], fromHistory: true, logFile: "/x.log" };
    let s = apply(base(), start(), { type: "history", runs: [hist] }, { type: "history", runs: [hist] });
    expect(s.runs.map((r) => r.id)).toEqual(["r1", "old"]);
    s = keys(s, "2", "j");
    s = update(s, { type: "key", key: "enter" });
    expect(s.viewRunId).toBe("old");
    expect(s.command).toEqual({ type: "load-log", runId: "old" });
    s = apply(s, { type: "command-done" }, { type: "log-loaded", runId: "old", lines: [{ stream: "stderr", text: "fatal: broke" }] });
    expect(viewRun(s)).toMatchObject({ fromHistory: false, lines: [{ text: "fatal: broke" }], errors: [{ kind: "generic", message: "fatal: broke" }] });
  });
});

describe("keys", () => {
  it("enter runs the selected command; a second run is refused while one is active", () => {
    let s = keys(base(), "j");
    s = update(s, { type: "key", key: "enter" });
    expect(s.command).toEqual({ type: "run", commandId: "root:lint" });
    s = apply(s, { type: "command-done" }, start());
    s = update(s, { type: "key", key: "j" });
    s = update(s, { type: "key", key: " " });
    expect(s.command).toBeUndefined();
    expect(s.notice).toMatch(/root:lint is still running \(x to cancel\)/);
    s = update(s, { type: "key", key: "j" });
    expect(s.notice).toBeUndefined();
  });

  it("a runs the checks chain, r re-runs the shown run, x cancels", () => {
    expect(update(base(), { type: "key", key: "a" }).command).toEqual({ type: "run", commandId: "chain:verify" });
    const noChecks = update(initialState("x", [cmd("root:test")]), { type: "key", key: "a" });
    expect(noChecks.command).toBeUndefined();
    expect(noChecks.notice).toMatch(/no checks found/);
    let s = apply(base(), start("r1", "core:test"), exit("r1", 1));
    expect(update(s, { type: "key", key: "r" }).command).toEqual({ type: "run", commandId: "core:test" });
    expect(update(s, { type: "key", key: "x" }).notice).toBe("nothing is running");
    s = apply(s, start("r2", "root:test"));
    expect(update(s, { type: "key", key: "x" }).command).toEqual({ type: "cancel" });
  });

  it("moves between panes with tab, shift-tab, numbers and h/l", () => {
    let s = base();
    expect(s.focus).toBe("commands");
    s = keys(s, "tab");
    expect(s.focus).toBe("runs");
    s = keys(s, "shift-tab", "shift-tab");
    expect(s.focus).toBe("errors");
    expect(keys(s, "3").focus).toBe("output");
    expect(keys(base(), "l").focus).toBe("output");
    expect(keys(base(), "2", "right").focus).toBe("errors");
    expect(keys(base(), "4", "h").focus).toBe("runs");
    expect(keys(base(), "3", "left").focus).toBe("commands");
  });

  it("moves selections within bounds with j/k, g/G and pages", () => {
    let s = keys(base(), "j", "j", "j", "j", "j");
    expect(s.selected.commands).toBe(3);
    s = keys(s, "g");
    expect(s.selected.commands).toBe(0);
    s = keys(s, "G");
    expect(s.selected.commands).toBe(3);
    s = keys(s, "k", "up", "home", "end", "ctrl-u");
    expect(s.selected.commands).toBe(1);
    s = keys(s, "ctrl-d", "pagedown", "pageup");
    expect(s.selected.commands).toBe(1);
  });

  it("q quits immediately when idle and asks first while running", () => {
    expect(update(base(), { type: "key", key: "q" }).command).toEqual({ type: "quit" });
    let s = apply(base(), start());
    s = update(s, { type: "key", key: "ctrl-c" });
    expect(s.mode).toBe("confirm-quit");
    expect(s.command).toBeUndefined();
    expect(update(s, { type: "key", key: "n" })).toMatchObject({ mode: "normal" });
    expect(update(s, { type: "key", key: "y" }).command).toEqual({ type: "quit" });
  });

  it("? opens help and any key closes it", () => {
    const s = keys(base(), "?");
    expect(s.mode).toBe("help");
    expect(keys(s, "j")).toMatchObject({ mode: "normal", selected: { commands: 0 } });
    expect(KEY_HELP.map(([k]) => k).join(" ")).toMatch(/enter.*a.*r.*x.*e.*f.*\/.*esc.*\?.*q/s);
  });
});

describe("output", () => {
  const withOutput = (n = 20) => keys(apply(base(), start(), out("r1", lines(n))), "3");

  it("follows the tail until scrolled up, and G follows again", () => {
    let s = withOutput();
    expect(s.follow).toBe(true);
    s = keys(s, "k");
    expect(s).toMatchObject({ follow: false, outputTop: 14 });
    s = keys(s, "ctrl-u");
    expect(s.outputTop).toBe(12);
    s = keys(s, "g");
    expect(s.outputTop).toBe(0);
    s = keys(s, "up");
    expect(s.outputTop).toBe(0);
    s = apply(s, out("r1", lines(5, "more")));
    expect(s.outputTop).toBe(0);
    s = keys(s, "G");
    expect(s.follow).toBe(true);
    s = keys(s, "k", "j");
    expect(s.follow).toBe(true);
    expect(keys(s, "f").follow).toBe(false);
  });

  it("clamps outputTop when the viewport grows", () => {
    let s = keys(withOutput(), "g");
    s = apply(s, { type: "viewport", outputRows: 30 });
    expect(s.outputTop).toBe(0);
    s = keys(apply(s, { type: "viewport", outputRows: 5 }), "end", "k", "k");
    s = apply(s, { type: "viewport", outputRows: 18 });
    expect(s.outputTop).toBe(2);
  });

  it("filters with /, edits the query, and esc clears it", () => {
    let s = keys(apply(base(), start(), out("r1", [...lines(3), { stream: "stderr", text: "ERROR here" }])), "/", "e", "r", "x", "backspace", "r");
    expect(s).toMatchObject({ mode: "search", query: "err" });
    expect(outputLines(s).lines.map((l) => l.text)).toEqual(["ERROR here"]);
    s = keys(s, "enter");
    expect(s).toMatchObject({ mode: "normal", query: "err" });
    s = keys(s, "escape");
    expect(s.query).toBe("");
    expect(keys(s, "/", "x", "escape")).toMatchObject({ mode: "normal", query: "" });
  });

  it("errors-only shows each error line with 3 lines of context", () => {
    const ls = [...lines(10), { stream: "stdout" as const, text: "src/a.ts(1,2): error TS1: bad" }, ...lines(10, "after")];
    let s = apply(base(), start(), out("r1", ls), exit("r1", 2));
    s = keys(s, "e");
    expect(outputLines(s).indexes).toEqual([10, 11, 12, 13]);
    expect(keys(s, "escape").errorsOnly).toBe(false);
  });

  it("enter on an error jumps the output to it, in normal and errors-only mode", () => {
    const ls = [...lines(30), { stream: "stdout" as const, text: "src/a.ts(1,2): error TS1: bad" }, ...lines(30, "after")];
    let s = apply(base(), start(), out("r1", ls), exit("r1", 2));
    s = keys(s, "4", "enter");
    expect(s).toMatchObject({ follow: false, outputTop: 30 });
    s = keys(s, "e", "enter");
    expect(s.outputTop).toBe(0);
    expect(outputLines(s).indexes[s.outputTop]).toBe(30);
  });

  it("selecting a run shows it, and selections clamp when lists shrink", () => {
    let s = apply(base(), start("r1"), exit("r1", 0), start("r2", "root:test"), exit("r2", 0));
    s = keys(s, "2", "j", "enter");
    expect(s.viewRunId).toBe("r1");
    s = update({ ...s, selected: { ...s.selected, errors: 9, runs: 9 } }, { type: "tick" });
    expect(s.selected).toMatchObject({ runs: 1, errors: 0 });
    expect(s.spinner).toBe(1);
  });
});

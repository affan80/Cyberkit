import type { ScanEvent } from "@cyberkit/core";
import { describe, expect, it } from "vitest";
import { type TuiState, initialState, update, visibleFindings } from "../src/state.js";
import { finding } from "./helpers.js";

const withFindings = (s: TuiState, fs = [finding({ severity: "low" }), finding({ severity: "critical" }), finding({ severity: "high" })]) =>
  fs.reduce((acc, f) => update(acc, { type: "scan-event", event: { type: "finding", finding: f } }), s);
const key = (s: TuiState, ...keys: string[]) => keys.reduce((acc, k) => update(acc, { type: "key", key: k }), s);
const base = () => update(initialState("./app", ["semgrep"]), { type: "scan-event", event: { type: "start", root: "/abs/app" } });

describe("initialState", () => {
  it("starts scanning with the findings pane focused and no filters", () => {
    const s = initialState("./app", ["semgrep"]);
    expect(s).toMatchObject({ target: "./app", phase: "scanning", focus: "findings", selected: 0, severity: "all", query: "", mode: "normal" });
    expect(s.pluginNames).toEqual(["semgrep"]);
  });
});

describe("scan events", () => {
  it("records the root, findings, plugin results and the final outcome", () => {
    let s = withFindings(base());
    s = update(s, { type: "scan-event", event: { type: "plugin", result: { name: "semgrep", status: "error", skipped: 0, truncated: false, durationMs: 3, findingCount: 0, error: "not installed" } } });
    s = update(s, { type: "scan-event", event: { type: "end", summary: { total: 3, bySeverity: { critical: 1, high: 1, medium: 0, low: 1, info: 0 } }, exitCode: 1, durationMs: 42 } });
    expect(s).toMatchObject({ root: "/abs/app", phase: "done", exitCode: 1, durationMs: 42 });
    expect(s.findings).toHaveLength(3);
    expect(s.plugins[0]?.status).toBe("error");
  });

  it("records a scan error", () => {
    const s = update(base(), { type: "scan-error", message: "scope root does not exist" });
    expect(s).toMatchObject({ phase: "error", error: "scope root does not exist" });
  });

  it("restart clears results but keeps filters and focus", () => {
    let s = key(withFindings(base()), "s", "2");
    s = update(s, { type: "restart" });
    expect(s).toMatchObject({ phase: "scanning", findings: [], plugins: [], selected: 0, severity: "critical", focus: "severity" });
  });
});

describe("visibleFindings", () => {
  it("sorts by severity, highest first", () => {
    expect(visibleFindings(withFindings(base())).map((f) => f.severity)).toEqual(["critical", "high", "low"]);
  });

  it("applies the severity filter and a case-insensitive query over rule, file, message and engine", () => {
    let s = withFindings(base(), [finding({ severity: "high", message: "lodahs looks like lodash" }), finding({ severity: "high", ruleId: "insecure-source" }), finding({ severity: "low", message: "LODASH again" })]);
    s = { ...s, query: "lodash" };
    expect(visibleFindings(s)).toHaveLength(2);
    s = { ...s, severity: "high" };
    expect(visibleFindings(s).map((f) => f.message)).toEqual(["lodahs looks like lodash"]);
  });
});

describe("navigation", () => {
  it("j/k and arrows move within bounds", () => {
    const s = withFindings(base());
    expect(key(s, "j").selected).toBe(1);
    expect(key(s, "j", "j", "j", "j").selected).toBe(2);
    expect(key(s, "down", "up", "k", "k").selected).toBe(0);
  });

  it("g/G/home/end and page keys jump", () => {
    const s = withFindings(base(), Array.from({ length: 30 }, () => finding()));
    expect(key(s, "G").selected).toBe(29);
    expect(key(s, "G", "g").selected).toBe(0);
    expect(key(s, "end", "home").selected).toBe(0);
    expect(key(s, "pagedown").selected).toBe(10);
    expect(key(s, "ctrl-d", "ctrl-d", "ctrl-u").selected).toBe(10);
  });

  it("tab, shift-tab and 1-4 move focus between panes", () => {
    const s = base();
    expect(key(s, "tab").focus).toBe("status");
    expect(key(s, "shift-tab").focus).toBe("plugins");
    expect(key(s, "2").focus).toBe("severity");
    expect(key(s, "3").focus).toBe("plugins");
    expect(key(s, "1", "4").focus).toBe("findings");
  });

  it("j/k on the severity pane changes the filter", () => {
    const s = key(withFindings(base()), "2", "j");
    expect(s.severity).toBe("critical");
    expect(key(s, "j", "k", "k").severity).toBe("all");
  });

  it("s cycles the severity filter and resets the selection", () => {
    const s = key(withFindings(base()), "j", "j", "s");
    expect(s).toMatchObject({ severity: "critical", selected: 0 });
    expect(key(s, "s", "s", "s", "s", "s").severity).toBe("all");
  });

  it("clamps the selection when a filter shrinks the list", () => {
    const s = key(withFindings(base()), "G", "s");
    expect(s.selected).toBe(0);
  });
});

describe("search, help and commands", () => {
  it("/ enters search; typing builds the query; backspace deletes; enter keeps it", () => {
    let s = key(base(), "/", "l", "o", "d", "x", "backspace");
    expect(s).toMatchObject({ mode: "search", query: "lod" });
    s = key(s, "enter");
    expect(s).toMatchObject({ mode: "normal", query: "lod" });
  });

  it("escape in search cancels and clears; escape in normal clears all filters", () => {
    expect(key(base(), "/", "a", "escape")).toMatchObject({ mode: "normal", query: "" });
    expect(key({ ...base(), query: "x", severity: "high" }, "escape")).toMatchObject({ query: "", severity: "all" });
  });

  it("q and j typed during search are text, not commands", () => {
    const s = key(base(), "/", "q", "j");
    expect(s.query).toBe("qj");
    expect(s.command).toBeUndefined();
  });

  it("? toggles help; any key closes it", () => {
    const s = key(base(), "?");
    expect(s.mode).toBe("help");
    expect(key(s, "x").mode).toBe("normal");
  });

  it.each([["q", "quit"], ["ctrl-c", "quit"], ["r", "rescan"], ["e", "export"]])("%s requests %s", (k, cmd) => {
    expect(key(base(), k).command).toBe(cmd);
  });

  it("ctrl-c quits even in search mode", () => {
    expect(key(base(), "/", "ctrl-c").command).toBe("quit");
  });

  it("is pure: never mutates the previous state", () => {
    const s = Object.freeze(withFindings(base()));
    expect(() => key(s, "j", "s", "/", "a", "enter", "tab")).not.toThrow();
  });
});

describe("batched scan events", () => {
  it("applies a batch exactly like the same events one by one", () => {
    const events: ScanEvent[] = [{ type: "start", root: "/r" }, ...[finding(), finding({ severity: "high" })].map((f): ScanEvent => ({ type: "finding", finding: f }))];
    const oneByOne = events.reduce((s, event) => update(s, { type: "scan-event", event }), initialState(".", []));
    const batched = update(initialState(".", []), { type: "scan-events", events });
    expect(batched).toEqual(oneByOne);
  });

  it("ingests 50k findings in one batch in linear time", () => {
    const events = Array.from({ length: 50_000 }, () => ({ type: "finding" as const, finding: finding() }));
    const t = performance.now();
    const s = update(initialState(".", []), { type: "scan-events", events });
    expect(s.findings).toHaveLength(50_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("visibleFindings memoisation", () => {
  it("returns the same list (no re-sort) when only the selection, focus or mode changes", () => {
    const s = withFindings(base());
    const first = visibleFindings(s);
    expect(visibleFindings(key(s, "j"))).toBe(first);
    expect(visibleFindings(key(s, "tab", "?"))).toBe(first);
  });

  it("recomputes when findings, the severity filter or the query change", () => {
    const s = withFindings(base());
    const first = visibleFindings(s);
    expect(visibleFindings(key(s, "s"))).not.toBe(first);
    expect(visibleFindings({ ...s, query: "x" })).not.toBe(first);
    expect(visibleFindings(withFindings(s, [finding()]))).not.toBe(first);
    expect(visibleFindings({ ...key(s, "s", "escape") })).toEqual(first);
  });
});

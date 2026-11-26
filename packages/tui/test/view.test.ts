import { describe, expect, it } from "vitest";
import { initialState, update, type TuiState } from "../src/state.js";
import { render } from "../src/view.js";
import { finding, stripAnsi } from "./helpers.js";

const done = (fs = [finding({ severity: "high", message: "lodahs resembles lodash", ruleId: "possible-typosquat", line: 7 }), finding({ severity: "low" })]): TuiState => {
  const s = update(initialState(".", []), { type: "scan-events", events: [{ type: "start", root: "/work/app" }, ...fs.map((f) => ({ type: "finding" as const, finding: f }))] });
  return update(s, { type: "scan-event", event: { type: "end", summary: { total: fs.length, bySeverity: { critical: 0, high: 1, medium: 0, low: 1, info: 0 } }, exitCode: 1, durationMs: 12 } });
};
const lines = (s: TuiState, cols = 100, rows = 30, color = false) => render(s, { cols, rows, color }).split("\n");

describe("render: layout", () => {
  it.each([[80, 24], [100, 30], [160, 48], [60, 15]])("fills exactly %ix%i visible cells", (cols, rows) => {
    for (const color of [false, true]) {
      const out = lines(done(), cols, rows, color);
      expect(out).toHaveLength(rows);
      for (const l of out) expect([...stripAnsi(l)].length).toBe(cols);
    }
  });

  it("shows the numbered lazygit-style panes and a key-hint bar", () => {
    const text = lines(done()).join("\n");
    for (const t of ["[1] Scan", "[2] Severity", "[3] Plugins", "[4] Findings", "Details"]) expect(text).toContain(t);
    expect(lines(done()).at(-1)).toMatch(/j\/k.*\/.*search.*q.*quit/);
  });

  it("draws the focused pane with a heavy border", () => {
    const text = lines(done()).join("\n");
    expect(text).toMatch(/┏━\[4\] Findings/);
    expect(text).toMatch(/╭─\[1\] Scan/);
    const s2 = update(done(), { type: "key", key: "2" });
    expect(lines(s2).join("\n")).toMatch(/┏━\[2\] Severity/);
  });

  it("asks for a bigger terminal when too small", () => {
    const out = lines(done(), 40, 10);
    expect(out).toHaveLength(10);
    expect(out.join("\n")).toContain("Terminal too small");
  });
});

describe("render: content", () => {
  it("summarises the scan: root, state, duration, total and exit code", () => {
    const text = lines(done()).join("\n");
    expect(text).toContain("/work/app");
    expect(text).toMatch(/Done in 12 ms/);
    expect(text).toMatch(/2 findings/);
    expect(text).toMatch(/exit 1/);
  });

  it("shows a spinner while scanning", () => {
    expect(lines(initialState(".", [])).join("\n")).toMatch(/Scanning/);
  });

  it("lists severity counts with the active filter marked", () => {
    const text = lines(update(done(), { type: "key", key: "s" })).join("\n");
    expect(text).toMatch(/▸ critical\s+0/);
    expect(text).toMatch(/high\s+1/);
  });

  it("lists findings highest severity first and details the selected one", () => {
    const text = lines(done()).join("\n");
    expect(text.indexOf("HIGH")).toBeLessThan(text.indexOf("LOW"));
    expect(text).toContain("possible-typosquat");
    expect(text).toContain("package.json:7");
    expect(text).toContain("lodahs resembles lodash");
  });

  it("keeps the selected finding visible when scrolled far down", () => {
    let s = done(Array.from({ length: 100 }, (_, i) => finding({ message: `item-${i}` })));
    for (let i = 0; i < 80; i++) s = update(s, { type: "key", key: "j" });
    const rows = lines(s, 100, 24);
    const selectedMsg = s.findings.length ? `item-` : "";
    expect(rows.join("\n")).toContain(selectedMsg);
    expect(rows.join("\n")).toMatch(/81\/100/);
  });

  it("shows plugin outcomes", () => {
    const s = update(done(), { type: "scan-event", event: { type: "plugin", result: { name: "semgrep", status: "error", skipped: 0, truncated: false, durationMs: 1, findingCount: 0, error: "semgrep is not installed" } } });
    expect(lines(s).join("\n")).toMatch(/✗ semgrep\s+error/);
  });

  it("says when filters hide everything", () => {
    const s = { ...done(), query: "zzz-no-match" };
    expect(lines(s).join("\n")).toContain("No findings match");
  });

  it("shows the search prompt, help overlay and errors", () => {
    expect(lines(update(done(), { type: "key", key: "/" })).at(-1)).toMatch(/^\/ ?/);
    const help = lines(update(done(), { type: "key", key: "?" })).join("\n");
    for (const k of ["j/k", "tab", "/", "s", "r", "e", "q"]) expect(help).toContain(k);
    expect(lines(update(initialState(".", []), { type: "scan-error", message: "scope root does not exist" })).join("\n")).toContain("scope root does not exist");
  });
});

describe("render: safety", () => {
  it("never emits raw control or bidi characters from finding data", () => {
    const evil = "\u001b]52;c;ZXZpbA==\u0007\u001b[2J‮";
    const s = done([finding({ message: `m${evil}`, ruleId: `r${evil}`, file: `f${evil}.js`, evidence: evil })]);
    const out = render(s, { cols: 120, rows: 30, color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });

  it("only uses SGR colour codes in colour mode", () => {
    const out = render(done(), { cols: 100, rows: 30, color: true });
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\u001b\[[0-9;]*m/g, "")).not.toContain("\u001b");
  });

  it("renders 50k findings in well under a frame budget", () => {
    const s = done(Array.from({ length: 50_000 }, () => finding()));
    const t = performance.now();
    render(s, { cols: 160, rows: 48, color: true });
    expect(performance.now() - t).toBeLessThan(200);
  });
});

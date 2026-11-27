/**
 * Pure renderer: state in, one full frame out. Every line is exactly `cols`
 * cells (one code point = one cell) and there are exactly `rows` lines, so the
 * app repaints by moving the cursor home and writing the frame. Every dynamic
 * string is escaped, so nothing in state can inject terminal sequences.
 */
import { escapeForTerminal } from "@cyberkit/core";
import { formatError } from "./errors.js";
import { type DevState, KEY_HELP, type Pane, activeRun, lastRunOf, outputLines, viewRun } from "./state.js";
import type { RunRecord, RunStatus } from "./types.js";

export interface RenderOptions {
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
  /** Wall clock in ms (for elapsed times); defaults to Date.now(). */
  readonly now?: number;
}

export const MIN_COLS = 70;
export const MIN_ROWS = 18;

type Segment = readonly [text: string, style?: string];
type Line = readonly Segment[];

const RESET = "\u001b[0m";
const STYLE = {
  focus: "\u001b[1;32m",
  border: "\u001b[2m",
  title: "\u001b[1m",
  dim: "\u001b[2m",
  key: "\u001b[36m",
  selected: "\u001b[7m",
  group: "\u001b[1;36m",
  ok: "\u001b[32m",
  bad: "\u001b[31m",
  run: "\u001b[33m",
  err: "\u001b[31m",
} as const;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const chars = (s: string): string[] => [...s];
const clean = (s: string): string => escapeForTerminal(s);

function fit(line: Line, width: number, color: boolean, fill?: string): string {
  let out = "";
  let used = 0;
  for (const [text, style] of line) {
    if (used >= width) break;
    const take = chars(text).slice(0, width - used);
    used += take.length;
    const s = take.join("");
    out += color && style ? `${style}${s}${RESET}` : s;
  }
  const pad = " ".repeat(Math.max(0, width - used));
  if (color && fill) return `${fill}${out.split(RESET).join(RESET + fill)}${pad}${RESET}`;
  return out + pad;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function icon(status: RunStatus, spinner: number): Segment {
  switch (status) {
    case "passed":
      return ["✓", STYLE.ok];
    case "failed":
      return ["✗", STYLE.bad];
    case "cancelled":
      return ["⊘", STYLE.dim];
    default:
      return [SPINNER[spinner % SPINNER.length] as string, STYLE.run];
  }
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function layout(cols: number, rows: number): { readonly outputRows: number; readonly panes: Readonly<Record<Pane, Rect>> } {
  const body = rows - 2;
  const lw = Math.max(30, Math.floor(cols * 0.36));
  const rw = cols - lw;
  const runsH = Math.max(5, Math.floor(body * 0.4));
  const errH = Math.max(5, Math.floor(body * 0.35));
  const panes = {
    commands: { x: 0, y: 1, w: lw, h: body - runsH },
    runs: { x: 0, y: 1 + body - runsH, w: lw, h: runsH },
    output: { x: lw, y: 1, w: rw, h: body - errH },
    errors: { x: lw, y: 1 + body - errH, w: rw, h: errH },
  };
  return { outputRows: Math.max(1, panes.output.h - 2), panes };
}

/** A bordered box: title in the top border, `content` rows inside (padded/cut to fit). */
function box(rect: Rect, title: string, content: readonly Line[], focused: boolean, color: boolean): string[] {
  const inner = rect.w - 2;
  const bstyle = focused ? STYLE.focus : STYLE.border;
  const t = chars(` ${title} `).slice(0, Math.max(0, inner - 1)).join("");
  const top = fit([["┌─", bstyle], [t, focused ? STYLE.focus : STYLE.title], ["─".repeat(rect.w), bstyle]], rect.w - 1, color) + (color ? `${bstyle}┐${RESET}` : "┐");
  const side = color ? `${bstyle}│${RESET}` : "│";
  const lines = [top];
  for (let i = 0; i < rect.h - 2; i++) lines.push(side + fit(content[i] ?? [], inner, color) + side);
  lines.push(color ? `${bstyle}└${"─".repeat(inner)}┘${RESET}` : `└${"─".repeat(inner)}┘`);
  return lines;
}

/** Keeps `sel` visible in a window of `height` rows over `total` rows. */
function windowStart(sel: number, height: number, total: number): number {
  if (total <= height || sel < 0) return 0;
  return Math.min(Math.max(0, sel - height + 1), total - height);
}

/** Highlights a selected row: inverse video across the whole width when coloured, a "›" marker otherwise. */
function selectedRow(line: Line, isSelected: boolean, focused: boolean, color: boolean, width: number): Line {
  if (!isSelected) return line;
  if (!color) return [[`${focused ? "›" : " "}`], ...line.slice(1)];
  const style = focused ? STYLE.selected : STYLE.title;
  const used = line.reduce((n, [t]) => n + chars(t).length, 0);
  return [...line.map(([t]): Segment => [t, style]), [" ".repeat(Math.max(0, width - used)), style]];
}

function commandsPane(s: DevState, rect: Rect, color: boolean): string[] {
  const inner = rect.w - 2;
  const rows: { line: Line; index?: number }[] = [];
  let group = "";
  s.commands.forEach((c, i) => {
    if (c.group !== group) {
      group = c.group;
      rows.push({ line: [[` ${clean(group)}`, STYLE.group]] });
    }
    const last = lastRunOf(s, c.id);
    const right: Segment[] = last ? [icon(last.status, s.spinner), [last.durationMs !== undefined ? ` ${formatDuration(last.durationMs)}` : "", STYLE.dim]] : [];
    const rightLen = right.reduce((n, [t]) => n + chars(t).length, 0);
    const name = `${c.id === "chain:verify" ? "▶" : " "} ${clean(c.name)}`;
    const nameW = Math.max(1, inner - rightLen - 2);
    rows.push({ line: [[" "], [fit([[name]], nameW, false)], [" "], ...right], index: i });
  });
  const selRow = rows.findIndex((r) => r.index === s.selected.commands);
  const from = windowStart(selRow, rect.h - 2, rows.length);
  const focused = s.focus === "commands";
  const content = rows.slice(from, from + rect.h - 2).map((r) => selectedRow(r.line, r.index === s.selected.commands && r.index !== undefined, focused, color, inner));
  return box(rect, "1 Commands", content, focused, color);
}

function runsPane(s: DevState, rect: Rect, color: boolean, now: number): string[] {
  const inner = rect.w - 2;
  const focused = s.focus === "runs";
  const from = windowStart(s.selected.runs, rect.h - 2, s.runs.length);
  const content = s.runs.slice(from, from + rect.h - 2).map((r, k): Line => {
    const dur = r.status === "running" ? formatDuration(Math.max(0, now - Date.parse(r.startedAt))) : r.durationMs !== undefined ? formatDuration(r.durationMs) : "";
    const errs = r.errors.length > 0 ? `  ${r.errors.length} err` : "";
    const line: Line = [[" "], icon(r.status, s.spinner), [` ${clock(r.startedAt)} `, STYLE.dim], [clean(r.label)], [`  ${dur}`, STYLE.dim], [errs, STYLE.err], [r.id === s.viewRunId ? "  ◂" : "", STYLE.key]];
    return selectedRow(line, from + k === s.selected.runs, focused, color, inner);
  });
  if (s.runs.length === 0) content.push([[" no runs yet: press enter on a command", STYLE.dim]]);
  return box(rect, "2 Runs", content, focused, color);
}

function statusText(r: RunRecord): string {
  if (r.status === "running") return "running";
  if (r.status === "cancelled") return "cancelled";
  return r.status === "passed" ? "✓ passed" : `✗ exit ${r.exitCode ?? r.signal ?? "?"}`;
}

function outputPane(s: DevState, rect: Rect, color: boolean): string[] {
  const run = viewRun(s);
  const focused = s.focus === "output";
  const height = rect.h - 2;
  if (!run) return box(rect, "3 Output", [[[" select a command and press enter to run it", STYLE.dim]]], focused, color);
  const { lines } = outputLines(s);
  const top = s.follow ? Math.max(0, lines.length - height) : Math.min(s.outputTop, Math.max(0, lines.length - height));
  const flags = [s.follow ? "follow" : `${top + 1}-${Math.min(lines.length, top + height)}`, s.errorsOnly ? "errors only" : "", s.query ? `/${clean(s.query)}` : ""].filter(Boolean).join(" · ");
  const total = run.lines.length + run.droppedLines;
  const title = `3 Output · ${clean(run.label)} · ${statusText(run)} · ${total.toLocaleString("en")} lines${run.fromHistory ? " (loading)" : ""} · ${flags}`;
  const content = lines.slice(top, top + height).map((l): Line => [[" "], [clean(l.text), l.stream === "stderr" ? STYLE.err : l.stream === "system" ? STYLE.key : undefined]]);
  if (lines.length === 0) content.push([[run.lines.length === 0 ? " (no output yet)" : " (nothing matches)", STYLE.dim]]);
  return box(rect, title, content, focused, color);
}

function errorsPane(s: DevState, rect: Rect, color: boolean): string[] {
  const run = viewRun(s);
  const focused = s.focus === "errors";
  const errors = run?.errors ?? [];
  const inner = rect.w - 2;
  const from = windowStart(s.selected.errors, rect.h - 2, errors.length);
  const content = errors.slice(from, from + rect.h - 2).map((e, k): Line => selectedRow([[" "], [clean(formatError(e)), STYLE.err]], from + k === s.selected.errors, focused, color, inner));
  if (run && errors.length === 0) content.push([[run.status === "running" ? " errors appear when the run finishes" : " no errors", STYLE.dim]]);
  return box(rect, `4 Errors (${errors.length})${run ? ` · ${clean(run.label)}` : ""}`, content, focused, color);
}

const HINTS: Readonly<Record<Pane, string>> = {
  commands: "enter run · a run all checks · r rerun · x cancel · tab panes · ? help · q quit",
  runs: "enter show run · r rerun · x cancel · tab panes · ? help · q quit",
  output: "j/k scroll · G follow · e errors only · / filter · f follow · ? help · q quit",
  errors: "enter jump to error · e errors only · tab panes · ? help · q quit",
};

function footer(s: DevState): Line {
  if (s.mode === "search") return [["/", STYLE.key], [clean(s.query)], ["▏", STYLE.dim], ["  enter keep · esc clear", STYLE.dim]];
  if (s.mode === "confirm-quit") return [["A command is running. Quit and cancel it? (y/n)", STYLE.run]];
  if (s.notice) return [[clean(s.notice), STYLE.run]];
  return [[HINTS[s.focus], STYLE.dim]];
}

function titleBar(s: DevState, cols: number, color: boolean, now: number): string {
  const left = ` CyberKit dev console · ${clean(s.repo)}`;
  const run = activeRun(s);
  const right = run
    ? `${SPINNER[s.spinner % SPINNER.length]} running ${clean(run.label)}  ${formatDuration(Math.max(0, now - Date.parse(run.startedAt)))} `
    : `idle · ${s.runs.length} run${s.runs.length === 1 ? "" : "s"} `;
  const gap = Math.max(1, cols - chars(left).length - chars(right).length);
  return fit([[left, STYLE.title], [" ".repeat(gap)], [right, run ? STYLE.run : STYLE.dim]], cols, color);
}

function helpScreen(s: DevState, cols: number, rows: number, color: boolean): string[] {
  const content: Line[] = [[["Keys", STYLE.title]], []];
  const kw = Math.max(...KEY_HELP.map(([k]) => chars(k).length));
  for (const [k, a] of KEY_HELP) content.push([["  "], [k.padEnd(kw + 3), STYLE.key], [a]]);
  content.push([], [["Runs are cached under node_modules/.cache/cyberkit-dev. Press any key to close.", STYLE.dim]]);
  return box({ x: 0, y: 1, w: cols, h: rows - 2 }, "Help", content, true, color);
}

export function render(state: DevState, options: RenderOptions): string {
  const { cols, rows, color } = options;
  const now = options.now ?? Date.now();
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `Terminal too small (need ${MIN_COLS}×${MIN_ROWS})`;
    const lines = Array.from({ length: rows }, () => " ".repeat(cols));
    const pad = Math.max(0, Math.floor((cols - chars(msg).length) / 2));
    lines[Math.floor(rows / 2)] = fit([[" ".repeat(pad) + msg]], cols, false);
    return lines.join("\n");
  }
  const { panes } = layout(cols, rows);
  let body: string[];
  if (state.mode === "help") {
    body = helpScreen(state, cols, rows, color);
  } else {
    const left = [...commandsPane(state, panes.commands, color), ...runsPane(state, panes.runs, color, now)];
    const right = [...outputPane(state, panes.output, color), ...errorsPane(state, panes.errors, color)];
    body = left.map((l, i) => l + (right[i] ?? ""));
  }
  return [titleBar(state, cols, color, now), ...body, fit([[" "], ...footer(state)], cols, color)].join("\n");
}

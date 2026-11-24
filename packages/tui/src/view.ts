/**
 * Pure renderer: state in, one full frame out. Every line is exactly `cols`
 * visible cells and there are exactly `rows` lines, so the app can repaint
 * by moving the cursor home and writing the frame. All finding data passes
 * through escapeForTerminal, so a finding cannot inject escape sequences.
 */
import { type Finding, type Severity, escapeForTerminal } from "@cyberkit/core";
import { type Pane, SEVERITY_FILTERS, type TuiState, visibleFindings } from "./state.js";

export interface RenderOptions {
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
}

export const MIN_COLS = 60;
export const MIN_ROWS = 15;

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
  ok: "\u001b[32m",
  bad: "\u001b[31m",
} as const;
const SEVERITY_STYLE: Readonly<Record<Severity, string>> = {
  critical: "\u001b[1;35m",
  high: "\u001b[31m",
  medium: "\u001b[33m",
  low: "\u001b[36m",
  info: "\u001b[2m",
};
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const EXIT_LABEL: Readonly<Record<number, string>> = { 0: "ok", 1: "findings", 2: "usage", 3: "scan error", 4: "partial" };

const chars = (s: string): string[] => [...s];
const clean = (s: string): string => escapeForTerminal(s);

/** Truncates/pads a list of segments to exactly `width` visible cells, styling only when `color`. */
function fit(line: Line, width: number, color: boolean, fill?: string): string {
  let out = "";
  let used = 0;
  for (const [text, style] of line) {
    if (used >= width) break;
    const cs = chars(text);
    const take = cs.slice(0, width - used);
    used += take.length;
    const s = take.join("");
    out += color && style ? `${style}${s}${RESET}` : s;
  }
  const pad = " ".repeat(width - used);
  if (color && fill) return `${fill}${out.split(RESET).join(RESET + fill)}${pad}${RESET}`;
  return out + pad;
}

/** Word-wraps plain text to `width`, hard-breaking words that are too long. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(" ")) {
      let w = word;
      while (chars(w).length > width) {
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        lines.push(chars(w).slice(0, width).join(""));
        w = chars(w).slice(width).join("");
      }
      if (!cur) cur = w;
      else if (chars(cur).length + 1 + chars(w).length <= width) cur += ` ${w}`;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    lines.push(cur);
  }
  return lines;
}

function box(title: string, body: readonly Line[], width: number, height: number, focused: boolean, color: boolean): string[] {
  const [tl, tr, bl, br, h, v] = focused ? ["┏", "┓", "┗", "┛", "━", "┃"] : ["╭", "╮", "╰", "╯", "─", "│"];
  const borderStyle = focused ? STYLE.focus : STYLE.border;
  const inner = width - 2;
  const label = chars(title).slice(0, Math.max(0, inner - 1)).join("");
  const top = fit([[tl + h, borderStyle], [label, focused ? STYLE.focus : STYLE.title], [h.repeat(Math.max(0, inner - 1 - chars(label).length)), borderStyle], [tr, borderStyle]], width, color);
  const lines = [top];
  for (let i = 0; i < height - 2; i++) {
    const content = body[i] ?? [];
    lines.push(fit([[v, borderStyle]], 1, color) + fit([[" "], ...content], inner, color) + fit([[v, borderStyle]], 1, color));
  }
  lines.push(fit([[bl + h.repeat(inner) + br, borderStyle]], width, color));
  return lines;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function statusPane(s: TuiState): Line[] {
  const root = clean(s.root ?? s.target);
  const state: Line =
    s.phase === "scanning"
      ? [[`${SPINNER[s.spinner % SPINNER.length]} Scanning…`, STYLE.key]]
      : s.phase === "error"
        ? [["✗ Error", STYLE.bad]]
        : [[`✓ Done in ${Math.round(s.durationMs ?? 0)} ms`, STYLE.ok]];
  const lines: Line[] = [[["Target ", STYLE.dim], [root]], state, [[plural(s.findings.length, "finding")]]];
  if (s.exitCode !== undefined) lines.push([[`exit ${s.exitCode}`, s.exitCode === 0 ? STYLE.ok : STYLE.bad], [` (${EXIT_LABEL[s.exitCode] ?? "?"})`, STYLE.dim]]);
  return lines;
}

function severityPane(s: TuiState, height: number): Line[] {
  const counts = new Map<string, number>([["all", s.findings.length]]);
  for (const f of s.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const lines: Line[] = SEVERITY_FILTERS.map((f) => {
    const active = f === s.severity;
    return [[active ? "▸ " : "  ", STYLE.focus], [f.padEnd(9), f === "all" ? undefined : SEVERITY_STYLE[f]], [String(counts.get(f) ?? 0).padStart(5), active ? STYLE.title : STYLE.dim]];
  });
  return windowAround(lines, SEVERITY_FILTERS.indexOf(s.severity), height);
}

function pluginsPane(s: TuiState): Line[] {
  const lines: Line[] = [[["● ", STYLE.ok], ["supply-chain", undefined], ["  engine", STYLE.dim]]];
  const reported = new Set(s.plugins.map((p) => p.name));
  for (const p of s.plugins) {
    const icon = p.status === "ok" ? "✓" : p.status === "timeout" ? "⏱" : "✗";
    lines.push([[`${icon} `, p.status === "ok" ? STYLE.ok : STYLE.bad], [clean(p.name).padEnd(12)], [` ${p.status}`, p.status === "ok" ? STYLE.dim : STYLE.bad], [p.status === "ok" ? `  ${p.findingCount}` : "", STYLE.dim]]);
  }
  for (const name of s.pluginNames) if (!reported.has(name)) lines.push([["… ", STYLE.key], [clean(name).padEnd(12)], [" running", STYLE.dim]]);
  return lines;
}

/** Picks `height` lines so that index `focus` is visible, centred when possible. */
function windowAround<T>(items: readonly T[], focus: number, height: number): T[] {
  if (items.length <= height) return [...items];
  const start = Math.min(Math.max(0, focus - Math.floor(height / 2)), items.length - height);
  return items.slice(start, start + height);
}

function findingRow(f: Finding, width: number, selected: boolean, color: boolean): Line {
  const loc = f.file === undefined ? "(project)" : `${clean(f.file)}${f.line === undefined ? "" : `:${f.line}`}`;
  const sev = f.severity.toUpperCase().padEnd(9);
  const row: Line = [[selected && !color ? "▸ " : "  "], [sev, SEVERITY_STYLE[f.severity]], [chars(loc).slice(0, 22).join("").padEnd(23)], [`${clean(f.engine)}/${clean(f.ruleId)}`.slice(0, 34).padEnd(35), STYLE.dim], [clean(f.message)]];
  return selected && color ? [[fit(row, width, false), STYLE.selected]] : row;
}

function detailsPane(s: TuiState, visible: readonly Finding[], inner: number): Line[] {
  if (s.phase === "error") return [[["Scan failed", STYLE.bad]], [], ...wrap(clean(s.error ?? "unknown error"), inner).map((l): Line => [[l]])];
  const f = visible[s.selected];
  if (!f) {
    if (s.query || s.severity !== "all") return [[["No findings match the current filters", STYLE.dim]], [["(esc clears filters)", STYLE.dim]]];
    return [[[s.phase === "scanning" ? "Waiting for findings…" : "No findings.", STYLE.dim]]];
  }
  const loc = f.file === undefined ? "(project)" : `${clean(f.file)}${f.line === undefined ? "" : `:${f.line}`}`;
  const lines: Line[] = [
    [[f.severity.toUpperCase(), SEVERITY_STYLE[f.severity]], ["  "], [`${clean(f.engine)}/${clean(f.ruleId)}`, STYLE.title]],
    [["Location  ", STYLE.dim], [loc]],
    [["ID        ", STYLE.dim], [f.id.slice(0, 16), STYLE.dim]],
    [],
    ...wrap(clean(f.message), inner).map((l): Line => [[l]]),
  ];
  if (f.evidence !== undefined) lines.push([], [["Evidence  ", STYLE.dim]], ...wrap(clean(f.evidence), inner).map((l): Line => [[l, STYLE.key]]));
  return lines;
}

const HELP: readonly (readonly [string, string])[] = [
  ["j/k ↑/↓", "move selection (on [2]: change severity filter)"],
  ["g/G", "first / last finding"],
  ["ctrl-d/u", "page down / up"],
  ["tab 1-4", "switch pane"],
  ["/", "search rule, file, message, engine"],
  ["s", "cycle severity filter"],
  ["esc", "clear search and filters"],
  ["r", "rescan"],
  ["e", "export JSON report to the current directory"],
  ["?", "toggle this help"],
  ["q", "quit (exit code = scan result)"],
];

function statusBar(s: TuiState, cols: number, color: boolean): string {
  if (s.mode === "search") return fit([["/", STYLE.key], [s.query], ["█", STYLE.key], ["   enter keep · esc cancel", STYLE.dim]], cols, color);
  if (s.notice) return fit([[s.notice, STYLE.ok]], cols, color);
  const hints: [string, string][] = [["j/k", "move"], ["tab", "pane"], ["/", "search"], ["s", "severity"], ["esc", "clear"], ["r", "rescan"], ["e", "export"], ["?", "help"], ["q", "quit"]];
  return fit(hints.flatMap(([k, d]): Segment[] => [[k, STYLE.key], [` ${d}  `, STYLE.dim]]), cols, color);
}

export function render(state: TuiState, { cols, rows, color }: RenderOptions): string {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `Terminal too small: need ${MIN_COLS}x${MIN_ROWS}, have ${cols}x${rows}`;
    const lines = Array.from({ length: rows }, () => " ".repeat(Math.max(0, cols)));
    lines[Math.floor(rows / 2)] = fit([[msg]], cols, false);
    return lines.join("\n");
  }
  const body = rows - 1;
  const leftW = Math.min(40, Math.max(26, Math.floor(cols * 0.32)));
  const rightW = cols - leftW;
  const focused = (p: Pane): boolean => state.focus === p;

  // Left column: Scan, Severity, Plugins.
  const scanH = 6;
  let pluginsH = 3;
  let sevH = body - scanH - pluginsH;
  if (sevH > SEVERITY_FILTERS.length + 2) {
    pluginsH += sevH - (SEVERITY_FILTERS.length + 2);
    sevH = SEVERITY_FILTERS.length + 2;
  }
  const left = [
    ...box("[1] Scan", statusPane(state), leftW, scanH, focused("status"), color),
    ...box("[2] Severity", severityPane(state, sevH - 2), leftW, sevH, focused("severity"), color),
    ...box("[3] Plugins", pluginsPane(state), leftW, pluginsH, focused("plugins"), color),
  ];

  // Right column: Findings list over Details (or Help).
  const visible = visibleFindings(state);
  const findingsH = Math.max(5, Math.floor(body * 0.55));
  const detailsH = body - findingsH;
  let right: string[];
  if (state.mode === "help") {
    right = box("Help", HELP.map(([k, d]): Line => [[k.padEnd(10), STYLE.key], [d]]), rightW, body, true, color);
  } else {
    const listH = findingsH - 2;
    const start = visible.length <= listH ? 0 : Math.min(Math.max(0, state.selected - Math.floor(listH / 2)), visible.length - listH);
    const rowsShown = visible.slice(start, start + listH).map((f, i) => findingRow(f, rightW - 3, start + i === state.selected, color));
    const filterNote = [state.severity !== "all" ? state.severity : "", state.query ? `"${clean(state.query)}"` : ""].filter(Boolean).join(" ");
    const count = visible.length ? `${state.selected + 1}/${visible.length}` : "0";
    const title = `[4] Findings ${count}${filterNote ? ` · ${filterNote}` : ""}`;
    right = [
      ...box(title, rowsShown, rightW, findingsH, focused("findings"), color),
      ...box("Details", detailsPane(state, visible, rightW - 3), rightW, detailsH, false, color),
    ];
  }

  const lines: string[] = [];
  for (let i = 0; i < body; i++) lines.push((left[i] ?? " ".repeat(leftW)) + (right[i] ?? " ".repeat(rightW)));
  lines.push(statusBar(state, cols, color));
  return lines.join("\n");
}

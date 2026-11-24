/**
 * TUI state and a pure reducer. Side effects (quit, rescan, export) are
 * requested through `command`, which the app consumes and clears.
 */
import { type Finding, type PluginSummary, type ScanEvent, SEVERITIES, type Severity, sortFindings } from "@cyberkit/core";

export const PANES = ["status", "severity", "plugins", "findings"] as const;
export type Pane = (typeof PANES)[number];
export type SeverityFilter = Severity | "all";
export type Command = "quit" | "rescan" | "export";

/** Filter options in display order: all, then most to least severe. */
export const SEVERITY_FILTERS: readonly SeverityFilter[] = ["all", ...[...SEVERITIES].reverse()];
const PAGE = 10;

export interface TuiState {
  readonly target: string;
  readonly root?: string;
  readonly pluginNames: readonly string[];
  readonly phase: "scanning" | "done" | "error";
  readonly findings: readonly Finding[];
  readonly plugins: readonly PluginSummary[];
  readonly focus: Pane;
  readonly selected: number;
  readonly severity: SeverityFilter;
  readonly query: string;
  readonly mode: "normal" | "search" | "help";
  readonly summary?: { readonly total: number; readonly bySeverity: Readonly<Record<Severity, number>> };
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly error?: string;
  readonly notice?: string;
  readonly spinner: number;
  readonly command?: Command;
}

export type Action =
  | { readonly type: "scan-event"; readonly event: ScanEvent }
  /** Several events at once: the app batches per frame so ingesting n findings is O(n), not O(n²). */
  | { readonly type: "scan-events"; readonly events: readonly ScanEvent[] }
  | { readonly type: "scan-error"; readonly message: string }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "tick" }
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "restart" }
  | { readonly type: "command-done" };

export function initialState(target: string, pluginNames: readonly string[]): TuiState {
  return { target, pluginNames, phase: "scanning", findings: [], plugins: [], focus: "findings", selected: 0, severity: "all", query: "", mode: "normal", spinner: 0 };
}

// Sorting is the dominant cost of a frame, so the filtered, sorted list is cached per findings
// array and only recomputed when the findings, the severity filter or the query change.
const visibleCache = new WeakMap<readonly Finding[], { severity: SeverityFilter; query: string; list: Finding[] }>();

export function visibleFindings(state: TuiState): Finding[] {
  const cached = visibleCache.get(state.findings);
  if (cached && cached.severity === state.severity && cached.query === state.query) return cached.list;
  const list = computeVisible(state);
  visibleCache.set(state.findings, { severity: state.severity, query: state.query, list });
  return list;
}

function computeVisible(state: TuiState): Finding[] {
  const q = state.query.toLowerCase();
  return sortFindings(
    state.findings.filter(
      (f) =>
        (state.severity === "all" || f.severity === state.severity) &&
        (q === "" || [f.ruleId, f.file ?? "", f.message, f.engine].some((v) => v.toLowerCase().includes(q))),
    ),
  );
}

const clampSelection = (s: TuiState): TuiState => {
  const max = Math.max(0, visibleFindings(s).length - 1);
  return s.selected > max ? { ...s, selected: max } : s;
};

const moveSelection = (s: TuiState, delta: number): TuiState => {
  const max = Math.max(0, visibleFindings(s).length - 1);
  return { ...s, selected: Math.min(max, Math.max(0, s.selected + delta)) };
};

const shiftSeverity = (s: TuiState, delta: number): TuiState => {
  const i = SEVERITY_FILTERS.indexOf(s.severity);
  const next = SEVERITY_FILTERS[(i + delta + SEVERITY_FILTERS.length) % SEVERITY_FILTERS.length] as SeverityFilter;
  return { ...s, severity: next, selected: 0 };
};

const shiftFocus = (s: TuiState, delta: number): TuiState => ({
  ...s,
  focus: PANES[(PANES.indexOf(s.focus) + delta + PANES.length) % PANES.length] as Pane,
});

function onKey(s: TuiState, key: string): TuiState {
  if (key === "ctrl-c") return { ...s, command: "quit" };
  if (s.mode === "help") return { ...s, mode: "normal" };
  if (s.mode === "search") {
    if (key === "enter") return { ...s, mode: "normal" };
    if (key === "escape") return { ...s, mode: "normal", query: "", selected: 0 };
    if (key === "backspace") return clampSelection({ ...s, query: [...s.query].slice(0, -1).join("") });
    if ([...key].length === 1) return { ...s, query: s.query + key, selected: 0 };
    return s;
  }
  const onSeverityPane = s.focus === "severity";
  switch (key) {
    case "q": return { ...s, command: "quit" };
    case "r": return { ...s, command: "rescan" };
    case "e": return { ...s, command: "export" };
    case "?": return { ...s, mode: "help" };
    case "/": return { ...s, mode: "search" };
    case "escape": return { ...s, query: "", severity: "all", selected: 0 };
    case "s": return shiftSeverity(s, 1);
    case "tab": return shiftFocus(s, 1);
    case "shift-tab": return shiftFocus(s, -1);
    case "1": case "2": case "3": case "4": return { ...s, focus: PANES[Number(key) - 1] as Pane };
    case "j": case "down": return onSeverityPane ? shiftSeverity(s, 1) : moveSelection(s, 1);
    case "k": case "up": return onSeverityPane ? shiftSeverity(s, -1) : moveSelection(s, -1);
    case "g": case "home": return { ...s, selected: 0 };
    case "G": case "end": return moveSelection(s, Number.MAX_SAFE_INTEGER);
    case "pagedown": case "ctrl-d": return moveSelection(s, PAGE);
    case "pageup": case "ctrl-u": return moveSelection(s, -PAGE);
    default: return s;
  }
}

/** Applies scan events with one copy of the findings/plugins arrays per call. */
function applyEvents(state: TuiState, events: readonly ScanEvent[]): TuiState {
  const findings = [...state.findings];
  const plugins = [...state.plugins];
  let next: TuiState = state;
  for (const e of events) {
    if (e.type === "start") next = { ...next, root: e.root };
    else if (e.type === "finding") findings.push(e.finding);
    else if (e.type === "plugin") plugins.push(e.result);
    else next = { ...next, phase: "done", summary: e.summary, exitCode: e.exitCode, durationMs: e.durationMs };
  }
  return { ...next, findings, plugins };
}

export function update(state: TuiState, action: Action): TuiState {
  switch (action.type) {
    case "key":
      return onKey(state.notice === undefined ? state : { ...state, notice: undefined }, action.key);
    case "tick":
      return { ...state, spinner: state.spinner + 1 };
    case "notice":
      return { ...state, notice: action.text };
    case "command-done":
      return { ...state, command: undefined };
    case "restart":
      return { ...state, phase: "scanning", root: undefined, findings: [], plugins: [], selected: 0, summary: undefined, exitCode: undefined, durationMs: undefined, error: undefined, command: undefined };
    case "scan-error":
      return { ...state, phase: "error", error: action.message };
    case "scan-event":
      return applyEvents(state, [action.event]);
    case "scan-events":
      return applyEvents(state, action.events);
  }
}

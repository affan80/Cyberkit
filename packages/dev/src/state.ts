/**
 * Console state and a pure reducer. Side effects (run, cancel, load a log,
 * quit) are requested through `command`, which the app consumes and clears.
 */
import { extractErrors } from "./errors.js";
import { type CommandSpec, type LogLine, MAX_MEMORY_LINES, type RunEvent, type RunRecord } from "./types.js";

export type Pane = "commands" | "runs" | "output" | "errors";
export const PANES: readonly Pane[] = ["commands", "runs", "output", "errors"];

export type DevCommand =
  | { readonly type: "run"; readonly commandId: string }
  | { readonly type: "cancel" }
  | { readonly type: "quit" }
  | { readonly type: "load-log"; readonly runId: string };

export interface DevState {
  readonly repo: string;
  readonly commands: readonly CommandSpec[];
  readonly runs: readonly RunRecord[];
  readonly activeRunId?: string;
  readonly viewRunId?: string;
  readonly focus: Pane;
  readonly selected: Readonly<Record<Pane, number>>;
  readonly follow: boolean;
  readonly outputTop: number;
  readonly outputRows: number;
  readonly errorsOnly: boolean;
  readonly query: string;
  readonly mode: "normal" | "search" | "help" | "confirm-quit";
  readonly notice?: string;
  readonly spinner: number;
  readonly command?: DevCommand;
}

export type Action =
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "run-events"; readonly events: readonly RunEvent[] }
  | { readonly type: "history"; readonly runs: readonly RunRecord[] }
  | { readonly type: "log-loaded"; readonly runId: string; readonly lines: readonly LogLine[]; readonly logFile?: string }
  | { readonly type: "log-file"; readonly runId: string; readonly logFile: string }
  | { readonly type: "viewport"; readonly outputRows: number }
  | { readonly type: "tick" }
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "command-done" };

export const KEY_HELP: ReadonlyArray<readonly [keys: string, action: string]> = [
  ["j/k ↓/↑", "move / scroll"],
  ["g/G home/end", "top / bottom (G follows output)"],
  ["ctrl-d/ctrl-u", "half page down / up"],
  ["tab shift-tab 1-4", "switch pane"],
  ["h/l ←/→", "left / right column"],
  ["enter space", "run command · show run · jump to error"],
  ["a", "run all checks (verify)"],
  ["r", "re-run the shown run"],
  ["x", "cancel the running command"],
  ["e", "errors only in output"],
  ["f", "toggle follow"],
  ["/", "filter output (esc clears)"],
  ["esc", "clear filter and errors-only"],
  ["?", "this help"],
  ["q ctrl-c", "quit"],
];

const HALF_PAGE = (s: DevState): number => Math.max(1, Math.floor(s.outputRows / 2));
const CONTEXT_AFTER = 3;

export function initialState(repo: string, commands: readonly CommandSpec[]): DevState {
  return {
    repo,
    commands,
    runs: [],
    focus: "commands",
    selected: { commands: 0, runs: 0, output: 0, errors: 0 },
    follow: true,
    outputTop: 0,
    outputRows: 10,
    errorsOnly: false,
    query: "",
    mode: "normal",
    spinner: 0,
  };
}

export const viewRun = (s: DevState): RunRecord | undefined => s.runs.find((r) => r.id === s.viewRunId);
export const activeRun = (s: DevState): RunRecord | undefined => s.runs.find((r) => r.id === s.activeRunId);
export const lastRunOf = (s: DevState, commandId: string): RunRecord | undefined => s.runs.find((r) => r.commandId === commandId);

/** The Output pane's lines after errors-only and the filter; `indexes` map back into run.lines. */
export function outputLines(s: DevState): { readonly lines: readonly LogLine[]; readonly indexes: readonly number[] } {
  const run = viewRun(s);
  if (!run) return { lines: [], indexes: [] };
  if (!s.errorsOnly && s.query === "") return { lines: run.lines, indexes: run.lines.map((_, i) => i) };
  let keep: Set<number> | undefined;
  if (s.errorsOnly) {
    keep = new Set();
    for (const e of run.errors) for (let i = e.lineIndex; i <= e.lineIndex + CONTEXT_AFTER && i < run.lines.length; i++) keep.add(i);
  }
  const q = s.query.toLowerCase();
  const lines: LogLine[] = [];
  const indexes: number[] = [];
  run.lines.forEach((l, i) => {
    if (keep && !keep.has(i)) return;
    if (q && !l.text.toLowerCase().includes(q)) return;
    lines.push(l);
    indexes.push(i);
  });
  return { lines, indexes };
}

const maxTop = (s: DevState): number => Math.max(0, outputLines(s).lines.length - s.outputRows);
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), Math.max(lo, hi));

function listLength(s: DevState, pane: Pane): number {
  if (pane === "commands") return s.commands.length;
  if (pane === "runs") return s.runs.length;
  if (pane === "errors") return viewRun(s)?.errors.length ?? 0;
  return 0;
}

function normalize(s: DevState): DevState {
  const selected = {
    commands: clamp(s.selected.commands, 0, s.commands.length - 1),
    runs: clamp(s.selected.runs, 0, s.runs.length - 1),
    output: 0,
    errors: clamp(s.selected.errors, 0, listLength(s, "errors") - 1),
  };
  return { ...s, selected, outputTop: s.follow ? s.outputTop : clamp(s.outputTop, 0, maxTop(s)) };
}

function setSelected(s: DevState, pane: Pane, value: number): DevState {
  return { ...s, selected: { ...s.selected, [pane]: clamp(value, 0, listLength(s, pane) - 1) } };
}

/** Scrolls the output by `delta` lines (negative = up); following turns off when scrolling away from the bottom. */
function scrollOutput(s: DevState, delta: number): DevState {
  const top = s.follow ? maxTop(s) : s.outputTop;
  const next = clamp(top + delta, 0, maxTop(s));
  return { ...s, follow: next >= maxTop(s), outputTop: next };
}

function startRun(s: DevState, commandId: string): DevState {
  const active = activeRun(s);
  if (active) return { ...s, notice: `${active.label} is still running (x to cancel)` };
  if (!s.commands.some((c) => c.id === commandId)) return { ...s, notice: commandId === "chain:verify" ? "no checks found (needs lint, typecheck, build or test scripts)" : `unknown command ${commandId}` };
  return { ...s, command: { type: "run", commandId }, notice: undefined };
}

function applyEvents(s: DevState, events: readonly RunEvent[]): DevState {
  let runs = s.runs;
  let { activeRunId, viewRunId, follow } = s;
  const pending = new Map<string, LogLine[]>();
  const flush = (): void => {
    if (pending.size === 0) return;
    runs = runs.map((r) => {
      const add = pending.get(r.id);
      if (!add) return r;
      const all = r.lines.concat(add);
      const drop = Math.max(0, all.length - MAX_MEMORY_LINES);
      return { ...r, lines: drop > 0 ? all.slice(drop) : all, droppedLines: r.droppedLines + drop };
    });
    pending.clear();
  };
  for (const e of events) {
    if (e.type === "lines") {
      const list = pending.get(e.runId);
      if (list) for (const l of e.lines) list.push(l);
      else pending.set(e.runId, [...e.lines]);
      continue;
    }
    flush();
    if (e.type === "start") {
      runs = [{ id: e.runId, commandId: e.commandId, label: e.label, status: "running", startedAt: e.startedAt, lines: [], droppedLines: 0, errors: [] }, ...runs.filter((r) => r.id !== e.runId)];
      activeRunId = e.runId;
      viewRunId = e.runId;
      follow = true;
    } else {
      runs = runs.map((r) => (r.id === e.runId ? { ...r, status: e.status, exitCode: e.exitCode, signal: e.signal, durationMs: e.durationMs, errors: extractErrors(r.lines, { exitCode: e.status === "passed" ? 0 : (e.exitCode ?? 1) }) } : r));
      if (activeRunId === e.runId) activeRunId = undefined;
    }
  }
  flush();
  return { ...s, runs, activeRunId, viewRunId, follow };
}

function onKey(s: DevState, key: string): DevState {
  if (s.mode === "help") return { ...s, mode: "normal" };
  if (s.mode === "confirm-quit") return key === "y" || key === "Y" ? { ...s, mode: "normal", command: { type: "quit" } } : { ...s, mode: "normal", notice: undefined };
  if (s.mode === "search") {
    if (key === "enter") return { ...s, mode: "normal" };
    if (key === "escape") return { ...s, mode: "normal", query: "" };
    if (key === "backspace") return { ...s, query: [...s.query].slice(0, -1).join("") };
    if (key === "ctrl-u") return { ...s, query: "" };
    if ([...key].length === 1 && key >= " ") return { ...s, query: s.query + key };
    return s;
  }

  const run = viewRun(s);
  switch (key) {
    case "q":
    case "ctrl-c":
      return s.activeRunId ? { ...s, mode: "confirm-quit" } : { ...s, command: { type: "quit" } };
    case "?":
      return { ...s, mode: "help" };
    case "/":
      return { ...s, mode: "search" };
    case "escape":
      return { ...s, query: "", errorsOnly: false, notice: undefined };
    case "tab":
      return { ...s, focus: PANES[(PANES.indexOf(s.focus) + 1) % PANES.length] as Pane };
    case "shift-tab":
      return { ...s, focus: PANES[(PANES.indexOf(s.focus) + PANES.length - 1) % PANES.length] as Pane };
    case "1":
    case "2":
    case "3":
    case "4":
      return { ...s, focus: PANES[Number(key) - 1] as Pane };
    case "h":
    case "left":
      return { ...s, focus: s.focus === "output" ? "commands" : s.focus === "errors" ? "runs" : s.focus };
    case "l":
    case "right":
      return { ...s, focus: s.focus === "commands" ? "output" : s.focus === "runs" ? "errors" : s.focus };
    case "a":
      return startRun(s, "chain:verify");
    case "x":
      return s.activeRunId ? { ...s, command: { type: "cancel" } } : { ...s, notice: "nothing is running" };
    case "r": {
      const id = run?.commandId ?? s.commands[s.selected.commands]?.id;
      return id ? startRun(s, id) : s;
    }
    case "e":
      return { ...s, errorsOnly: !s.errorsOnly, follow: true };
    case "f":
      return { ...s, follow: !s.follow, outputTop: s.follow ? maxTop(s) : s.outputTop };
  }

  if (s.focus === "output") {
    switch (key) {
      case "j":
      case "down":
        return scrollOutput(s, 1);
      case "k":
      case "up":
        return scrollOutput(s, -1);
      case "ctrl-d":
      case "pagedown":
        return scrollOutput(s, HALF_PAGE(s));
      case "ctrl-u":
      case "pageup":
        return scrollOutput(s, -HALF_PAGE(s));
      case "g":
      case "home":
        return { ...s, follow: maxTop(s) === 0, outputTop: 0 };
      case "G":
      case "end":
        return { ...s, follow: true, outputTop: maxTop(s) };
    }
    return s;
  }

  const pane = s.focus;
  const cur = s.selected[pane];
  switch (key) {
    case "j":
    case "down":
      return setSelected(s, pane, cur + 1);
    case "k":
    case "up":
      return setSelected(s, pane, cur - 1);
    case "ctrl-d":
    case "pagedown":
      return setSelected(s, pane, cur + HALF_PAGE(s));
    case "ctrl-u":
    case "pageup":
      return setSelected(s, pane, cur - HALF_PAGE(s));
    case "g":
    case "home":
      return setSelected(s, pane, 0);
    case "G":
    case "end":
      return setSelected(s, pane, listLength(s, pane) - 1);
    case "enter":
    case " ":
      return activate(s);
  }
  return s;
}

function activate(s: DevState): DevState {
  if (s.focus === "commands") {
    const cmd = s.commands[s.selected.commands];
    return cmd ? startRun(s, cmd.id) : s;
  }
  if (s.focus === "runs") {
    const run = s.runs[s.selected.runs];
    if (!run) return s;
    const next: DevState = { ...s, viewRunId: run.id, follow: true, selected: { ...s.selected, errors: 0 } };
    return run.fromHistory ? { ...next, command: { type: "load-log", runId: run.id } } : next;
  }
  if (s.focus === "errors") {
    const run = viewRun(s);
    const err = run?.errors[s.selected.errors];
    if (!run || !err) return s;
    const base: DevState = { ...s, query: "", follow: false };
    const { indexes } = outputLines(base);
    let pos = indexes.indexOf(err.lineIndex);
    if (pos === -1) pos = indexes.findIndex((i) => i > err.lineIndex);
    return { ...base, outputTop: clamp(pos === -1 ? 0 : pos, 0, maxTop(base)) };
  }
  return s;
}

export function update(state: DevState, action: Action): DevState {
  let next: DevState;
  switch (action.type) {
    case "key":
      next = onKey({ ...state, notice: undefined }, action.key); // a notice lasts until the next key
      break;
    case "run-events":
      next = applyEvents(state, action.events);
      break;
    case "history": {
      const known = new Set(state.runs.map((r) => r.id));
      next = { ...state, runs: [...state.runs, ...action.runs.filter((r) => !known.has(r.id))] };
      break;
    }
    case "log-loaded":
      next = {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId
            ? {
                ...r,
                lines: action.lines,
                errors: r.errors.length > 0 && r.errors.every((e) => e.lineIndex < action.lines.length) ? r.errors : extractErrors(action.lines, { exitCode: r.status === "passed" ? 0 : (r.exitCode ?? 1) }),
                fromHistory: false,
                ...(action.logFile ? { logFile: action.logFile } : {}),
              }
            : r,
        ),
      };
      break;
    case "log-file":
      next = { ...state, runs: state.runs.map((r) => (r.id === action.runId ? { ...r, logFile: action.logFile } : r)) };
      break;
    case "viewport":
      next = { ...state, outputRows: Math.max(1, action.outputRows) };
      break;
    case "tick":
      next = { ...state, spinner: (state.spinner + 1) % 1000 };
      break;
    case "notice":
      next = { ...state, notice: action.text };
      break;
    case "command-done": {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { command: _done, ...rest } = state;
      next = rest;
      break;
    }
  }
  return normalize(next);
}

/**
 * The error log: pulls the errors out of a run's output so they can be read
 * (and jumped to) without scrolling through thousands of lines. One linear
 * pass; every regex is anchored and free of nested quantifiers.
 */
import type { ErrorEntry, LogLine } from "./types.js";

const TS_PAREN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const TS_PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/;
const ESLINT_FILE = /^(?:\/|[A-Za-z]:[\\/])\S/;
const ESLINT_ERROR = /^\s+(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)\s*$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S+)\s+>\s+(.+)$/;
const ERROR_LINE = /^\s*((?:Uncaught )?(?:[A-Z]\w*)?Error\b.*)$/;
const VITEST_LOC = /^\s*❯\s+(\S+?):(\d+):(\d+)\s*$/;
const EXCEPTION = /^\s*(?:Uncaught )?((?:[A-Z]\w*)?Error): (.+)$/;
const STACK = /^\s+at (?:.*\()?(\S+?):(\d+):(\d+)\)?$/;
const NPM = /^npm (?:error|ERR!) (.+)$/;

const npmRank = (msg: string): number => (msg.includes("Lifecycle script") ? 3 : msg.includes("command failed") ? 2 : /^code E/.test(msg) ? 1 : 0);

export function extractErrors(lines: readonly LogLine[], options: { exitCode?: number | null; maxErrors?: number } = {}): ErrorEntry[] {
  const max = options.maxErrors ?? 200;
  const found: ErrorEntry[] = [];
  const seen = new Set<string>();
  const consumed = new Set<number>(); // error-message lines already attributed to a test failure
  let eslintFile: string | undefined;
  let npm: ErrorEntry | undefined;

  const add = (e: ErrorEntry): void => {
    const key = [e.kind, e.file, e.line, e.col, e.message].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    found.push(e);
  };
  const textAt = (i: number): string => (lines[i] as LogLine).text;

  for (let i = 0; i < lines.length && found.length < max; i++) {
    const text = textAt(i);
    // Never errors, even when they quote error-looking text: npm's "> script" / "> command" echo,
    // and the console's own system lines (chain step headers). The generic fallback below still sees them.
    if (text.startsWith("> ") || (lines[i] as LogLine).stream === "system") continue;

    const ts = TS_PAREN.exec(text) ?? TS_PRETTY.exec(text);
    if (ts) {
      add({ kind: "typescript", file: ts[1] as string, line: Number(ts[2]), col: Number(ts[3]), rule: ts[4] as string, message: ts[5] as string, lineIndex: i });
      continue;
    }

    // ESLint stylish: an unindented absolute path, then indented "line:col  error  message  rule" rows.
    if (ESLINT_FILE.test(text)) {
      eslintFile = text.trim();
      continue;
    }
    if (eslintFile !== undefined) {
      const es = ESLINT_ERROR.exec(text);
      if (es) {
        add({ kind: "eslint", file: eslintFile, line: Number(es[1]), col: Number(es[2]), rule: es[4] as string, message: es[3] as string, lineIndex: i });
        continue;
      }
      if (text.trim() === "") eslintFile = undefined;
    }

    // vitest: only "FAIL file > suite > test" creates an entry, so each failure counts once.
    const fail = VITEST_FAIL.exec(text);
    if (fail) {
      let message: string | undefined;
      let loc: RegExpExecArray | null = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 16); j++) {
        const t = textAt(j);
        if (VITEST_FAIL.test(t)) break;
        if (message === undefined) {
          const m = ERROR_LINE.exec(t);
          if (m) {
            message = (m[1] as string).trim();
            consumed.add(j);
          }
        }
        loc ??= VITEST_LOC.exec(t);
        if (loc && message !== undefined) break;
      }
      add({
        kind: "test",
        file: loc ? (loc[1] as string) : (fail[1] as string),
        ...(loc ? { line: Number(loc[2]), col: Number(loc[3]) } : {}),
        test: (fail[2] as string).trim().split(/ +> +/).join(" > "),
        message: message ?? "test failed",
        lineIndex: i,
      });
      continue;
    }

    if (!consumed.has(i)) {
      const ex = EXCEPTION.exec(text);
      if (ex) {
        let at: RegExpExecArray | null = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          const m = STACK.exec(textAt(j));
          if (m && !(m[1] as string).startsWith("node:")) {
            at = m;
            break;
          }
        }
        add({ kind: "exception", message: `${ex[1]}: ${ex[2]}`, ...(at ? { file: at[1] as string, line: Number(at[2]), col: Number(at[3]) } : {}), lineIndex: i });
        continue;
      }
    }

    const n = NPM.exec(text);
    if (n) {
      const message = (n[1] as string).trim();
      if (npmRank(message) > (npm ? npmRank(npm.message) : 0)) npm = { kind: "npm", message, lineIndex: i };
    }
  }

  if (npm && found.length < max) add(npm);
  found.sort((a, b) => a.lineIndex - b.lineIndex);

  // Nothing recognised but the run failed: show its last stderr line (else the last line).
  const failed = options.exitCode !== undefined && options.exitCode !== 0;
  if (found.length === 0 && failed) {
    let pick = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i] as LogLine;
      if (l.text.trim() === "") continue;
      if (l.stream === "stderr") {
        pick = i;
        break;
      }
      if (pick === -1) pick = i;
    }
    if (pick !== -1) found.push({ kind: "generic", message: textAt(pick).trim(), lineIndex: pick });
  }
  return found;
}

export function formatError(e: ErrorEntry): string {
  const where = e.file === undefined ? undefined : [e.file, e.line, e.col].filter((p) => p !== undefined).join(":");
  return [e.kind, where, e.test, e.rule, e.message].filter((p) => p !== undefined && p !== "").join("  ");
}

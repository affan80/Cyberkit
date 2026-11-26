import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TerminalIn, TerminalOut } from "../src/app.js";

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/** A fake terminal: records output, lets tests type keys and resize. */
export function fakeTerminal(cols = 100, rows = 30) {
  let onData: ((chunk: string | Buffer) => void) | undefined;
  let onResize: (() => void) | undefined;
  const writes: string[] = [];
  const state = { raw: false, paused: true };
  const stdin: TerminalIn = {
    isTTY: true,
    setRawMode: (on: boolean) => (state.raw = on),
    setEncoding: () => undefined,
    resume: () => (state.paused = false),
    pause: () => (state.paused = true),
    on: (_e, fn) => (onData = fn),
    off: () => (onData = undefined),
  };
  const stdout: TerminalOut & { isTTY: boolean; columns: number; rows: number } = {
    isTTY: true,
    columns: cols,
    rows,
    write: (chunk: string) => writes.push(chunk),
    on: (_e, fn) => (onResize = fn),
    off: () => (onResize = undefined),
  };
  return {
    stdin,
    stdout,
    state,
    writes,
    type: (keys: string) => onData?.(keys),
    resize: () => onResize?.(),
    /** The last full frame drawn, without colour codes. */
    screen: () => {
      const frames = writes.filter((w) => w.startsWith("\u001b[H"));
      return stripAnsi((frames.at(-1) ?? "").slice(3)).split("\r\n").join("\n");
    },
    output: () => writes.join(""),
  };
}

/** Waits until `check()` is true (polling), or fails after `ms`. */
export async function until(check: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A throwaway repo whose npm scripts run small node snippets. */
export async function fixtureRepo(scripts: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-dev-repo-")));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"], scripts }, null, 2));
  await mkdir(path.join(root, "packages"));
  return root;
}

/** `node -e` script bodies for package.json (single-quoted JS so the JSON stays simple). */
export const NODE_SCRIPTS = {
  pass: `node -e "console.log('all good')"`,
  tsError: `node -e "console.log('compiling'); console.log('src/a.ts(3,5): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`,
  slow: `node -e "console.log('started'); setInterval(() => {}, 1000)"`,
};

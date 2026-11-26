import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runApp } from "../src/app.js";
import { stripAnsi } from "./helpers.js";

class FakeIn extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(on: boolean) { this.raw.push(on); return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  type(s: string) { this.emit("data", s); }
}
class FakeOut extends EventEmitter {
  columns = 100;
  rows = 30;
  chunks: string[] = [];
  write(s: string) { this.chunks.push(s); return true; }
  get text() { return this.chunks.join(""); }
  get lastFrame() { const i = this.text.lastIndexOf("\u001b[H"); return stripAnsi(this.text.slice(i)); }
}
const waitFor = async (cond: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "ck-tui-app-")));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodahs: "1.0.0", left: "*" } }, null, 2));
  await writeFile(path.join(dir, "package-lock.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function start(opts: Partial<Parameters<typeof runApp>[0]> = {}) {
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const done = runApp({ target: dir, plugins: [], failOn: "low", color: false, cwd: dir, now: () => new Date("2026-01-02T03:04:05Z"), ...opts }, { stdin, stdout });
  return { stdin, stdout, done };
}

describe("runApp", () => {
  it("takes over the terminal, streams findings and restores everything on quit", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    expect(stdout.text.startsWith("\u001b[?1049h\u001b[?25l")).toBe(true);
    expect(stdin.raw).toEqual([true]);
    expect(stdout.lastFrame).toContain("possible-typosquat");
    stdin.type("q");
    expect(await done).toBe(1);
    expect(stdout.text.endsWith("\u001b[?25h\u001b[?1049l")).toBe(true);
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("uses CRLF line breaks so frames render correctly in raw mode", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdin.type("q");
    await done;
    const frame = stdout.text.slice(stdout.text.lastIndexOf("\u001b[H"));
    expect(frame).toContain("\r\n");
    expect(frame.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("navigates with keys and re-renders", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdin.type("s");
    await waitFor(() => stdout.lastFrame.includes("[4] Findings 0 · critical"));
    stdin.type("\u001b");
    await waitFor(() => stdout.lastFrame.includes("[4] Findings 1/2"));
    stdin.type("q");
    await done;
  });

  it("re-renders at the new size on resize", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdout.columns = 140;
    stdout.emit("resize");
    await waitFor(() => stdout.lastFrame.split("\r\n")[0]?.length === 140);
    stdin.type("q");
    await done;
  });

  it("rescans on r", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    stdin.type("r");
    await waitFor(() => stdout.lastFrame.includes("0 findings") && stdout.lastFrame.includes("Done in"));
    stdin.type("q");
    expect(await done).toBe(0);
  });

  it("exports the shown findings to a new file and never overwrites or follows a symlink", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdin.type("e");
    await waitFor(() => /Exported 2 findings to cyberkit-report-2026-01-02T03-04-05Z\.json/.test(stdout.lastFrame));
    const report = JSON.parse(await readFile(path.join(dir, "cyberkit-report-2026-01-02T03-04-05Z.json"), "utf8")) as { summary: { total: number } };
    expect(report.summary.total).toBe(2);
    stdin.type("e");
    await waitFor(() => /Export failed/.test(stdout.lastFrame));
    stdin.type("q");
    await done;
  });

  it("refuses to export through a planted symlink", async () => {
    const victim = path.join(dir, "victim.txt");
    await writeFile(victim, "original");
    await symlink(victim, path.join(dir, "cyberkit-report-2026-01-02T03-04-05Z.json"));
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdin.type("e");
    await waitFor(() => /Export failed/.test(stdout.lastFrame));
    expect(await readFile(victim, "utf8")).toBe("original");
    stdin.type("q");
    await done;
  });

  it("shows a scan error and exits 3 for a missing target", async () => {
    const { stdin, stdout, done } = start({ target: path.join(dir, "missing") });
    await waitFor(() => stdout.lastFrame.includes("Scan failed"));
    stdin.type("q");
    expect(await done).toBe(3);
  });

  it("exits 130 when quitting before the scan finishes", async () => {
    const slow = { name: "slow", run: () => new Promise<never>(() => {}) };
    const { stdin, done } = start({ plugins: [slow as never] });
    await new Promise((r) => setTimeout(r, 50));
    stdin.type("\u0003");
    expect(await done).toBe(130);
  });

  it("restores the terminal when aborted (SIGTERM path)", async () => {
    const ac = new AbortController();
    const { stdin, stdout, done } = start({ signal: ac.signal });
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    ac.abort();
    expect(await done).toBe(143);
    expect(stdout.text.endsWith("\u001b[?25h\u001b[?1049l")).toBe(true);
    expect(stdin.raw.at(-1)).toBe(false);
  });

  it("does not leave files behind in cwd unless asked", async () => {
    const { stdin, stdout, done } = start();
    await waitFor(() => stdout.lastFrame.includes("Done in"));
    stdin.type("q");
    await done;
    expect((await readdir(dir)).sort()).toEqual(["package-lock.json", "package.json"]);
  });
});

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHistory, createLogWriter, defaultCacheDir, fromHistoryEntry, loadHistory, readLog, saveRun, toHistoryEntry } from "../src/history.js";
import { type HistoryEntry, type LogLine, MAX_HISTORY_RUNS, type RunRecord } from "../src/types.js";

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-dev-hist-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-dev-out-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const entry = (id: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, commandId: "root:test", label: "test", status: "passed", startedAt: "2026-11-27T04:00:00.000Z", durationMs: 1200, exitCode: 0, signal: null, errorCount: 0, errors: [], ...over,
});

describe("history", () => {
  it("puts the cache under node_modules/.cache", () => {
    expect(defaultCacheDir("/repo")).toBe(path.join("/repo", "node_modules", ".cache", "cyberkit-dev"));
  });

  it("saves and loads runs newest first", async () => {
    await saveRun(dir, entry("r1"));
    await saveRun(dir, entry("r2", { status: "failed", exitCode: 1, errorCount: 1, errors: [{ kind: "npm", message: "x", lineIndex: 0 }] }));
    const runs = await loadHistory(dir);
    expect(runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(runs[0]).toMatchObject({ status: "failed", errorCount: 1 });
    expect((await readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("caps the history and deletes the logs of dropped runs", async () => {
    const w = createLogWriter(dir, "r0", "test");
    w.write([{ stream: "stdout", text: "hi" }]);
    const logFile = await w.close();
    await saveRun(dir, entry("r0", { logFile }));
    for (let i = 1; i <= MAX_HISTORY_RUNS; i++) await saveRun(dir, entry(`r${i}`));
    const runs = await loadHistory(dir);
    expect(runs).toHaveLength(MAX_HISTORY_RUNS);
    expect(runs.some((r) => r.id === "r0")).toBe(false);
    await expect(stat(logFile)).rejects.toThrow();
  }, 20_000);

  it("returns [] for a missing or corrupt history and never throws on I/O errors", async () => {
    expect(await loadHistory(path.join(dir, "nope"))).toEqual([]);
    await writeFile(path.join(dir, "history.json"), "{ corrupt");
    expect(await loadHistory(dir)).toEqual([]);
    const file = path.join(dir, "a-file");
    await writeFile(file, "x");
    await expect(saveRun(file, entry("r1"))).resolves.toBeUndefined();
    const w = createLogWriter(path.join(file, "sub"), "r1", "x");
    w.write([{ stream: "stdout", text: "x" }]);
    await expect(w.close()).resolves.toBeTypeOf("string");
  });

  it("writes and reads back all three streams, redacting again on write", async () => {
    const lines: LogLine[] = [
      { stream: "system", text: "▶ lint: eslint ." },
      { stream: "stdout", text: "ok" },
      { stream: "stderr", text: `leak ${GH}` },
    ];
    const w = createLogWriter(dir, "r1", "lint");
    w.write(lines);
    const file = await w.close();
    expect(file).toBe(path.join(dir, "logs", "r1.log"));
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("ghp_");
    expect(raw.split("\n")[0]).toMatch(/^# lint · started /);
    const back = await readLog(file);
    expect(back.map((l) => l.stream)).toEqual(["system", "stdout", "stderr"]);
    expect(back[1]?.text).toBe("ok");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readLog(file, 2)).toHaveLength(2);
  });

  it("stops at the byte cap with a marker", async () => {
    const w = createLogWriter(dir, "big", "x", { maxBytes: 1000 });
    w.write(Array.from({ length: 100 }, () => ({ stream: "stdout" as const, text: "y".repeat(50) })));
    const raw = await readFile(await w.close(), "utf8");
    expect(raw.length).toBeLessThan(1200);
    expect(raw.trimEnd().endsWith("# log truncated")).toBe(true);
  });

  it("never writes through a planted symlink", async () => {
    await mkdir(path.join(dir, "logs"), { recursive: true });
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original");
    await symlink(victim, path.join(dir, "logs", "evil.log"));
    const w = createLogWriter(dir, "evil", "x");
    w.write([{ stream: "stdout", text: "pwned" }]);
    await w.close();
    expect(await readFile(victim, "utf8")).toBe("original");
  });

  it("converts runs to history entries and back", () => {
    const run: RunRecord = {
      id: "r1", commandId: "root:lint", label: "lint", status: "failed", startedAt: "2026-11-27T04:00:00.000Z", durationMs: 50, exitCode: 1, signal: null,
      lines: [{ stream: "stdout", text: "x" }], droppedLines: 0, errors: Array.from({ length: 80 }, (_, i) => ({ kind: "eslint" as const, message: `e${i}`, lineIndex: 0 })), logFile: "/x.log",
    };
    const e = toHistoryEntry(run);
    expect(e).toMatchObject({ id: "r1", status: "failed", errorCount: 80, logFile: "/x.log" });
    expect(e.errors).toHaveLength(50);
    expect(fromHistoryEntry(e)).toMatchObject({ id: "r1", fromHistory: true, lines: [], droppedLines: 0 });
  });

  it("clears the cache", async () => {
    await saveRun(dir, entry("r1"));
    await clearHistory(dir);
    expect(await loadHistory(dir)).toEqual([]);
  });
});

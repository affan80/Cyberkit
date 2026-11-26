/**
 * The run cache: history.json plus one redacted log file per run, under
 * node_modules/.cache/cyberkit-dev. Persistence must never crash or hang the
 * console, so every I/O error is swallowed (logs just stop being written).
 */
import { type WriteStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "@cyberkit/core";
import { type HistoryEntry, type LogLine, MAX_HISTORY_ERRORS, MAX_HISTORY_RUNS, MAX_LOG_BYTES, MAX_MEMORY_LINES, type RunRecord, type Stream } from "./types.js";

const PREFIX: Readonly<Record<Stream, string>> = { stdout: "  ", stderr: "! ", system: "# " };

export const defaultCacheDir = (root: string): string => path.join(root, "node_modules", ".cache", "cyberkit-dev");
const historyFile = (dir: string): string => path.join(dir, "history.json");

export async function loadHistory(cacheDir: string): Promise<HistoryEntry[]> {
  try {
    const json = JSON.parse(await readFile(historyFile(cacheDir), "utf8")) as { version?: unknown; runs?: unknown };
    if (json.version !== 1 || !Array.isArray(json.runs)) return [];
    return json.runs.filter((r): r is HistoryEntry => typeof r === "object" && r !== null && typeof (r as HistoryEntry).id === "string");
  } catch {
    return [];
  }
}

/** Serialises saves within this process so concurrent saves can't lose entries. */
let saving: Promise<void> = Promise.resolve();

export function saveRun(cacheDir: string, entry: HistoryEntry): Promise<void> {
  const task = saving.then(async () => {
    try {
      await mkdir(cacheDir, { recursive: true });
      const runs = [redactEntry(entry), ...(await loadHistory(cacheDir)).filter((r) => r.id !== entry.id)];
      const kept = runs.slice(0, MAX_HISTORY_RUNS);
      const tmp = path.join(cacheDir, `.history.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmp, `${JSON.stringify({ version: 1, runs: kept })}\n`, { mode: 0o600 });
      await rename(tmp, historyFile(cacheDir));
      for (const dropped of runs.slice(MAX_HISTORY_RUNS)) {
        if (dropped.logFile && path.dirname(dropped.logFile) === path.join(cacheDir, "logs")) await rm(dropped.logFile, { force: true });
      }
    } catch {
      // the cache is a convenience; never fail a run because of it
    }
  });
  saving = task;
  return task;
}

function redactEntry(e: HistoryEntry): HistoryEntry {
  return { ...e, errors: e.errors.slice(0, MAX_HISTORY_ERRORS).map((x) => ({ ...x, message: redact(x.message), ...(x.file ? { file: redact(x.file) } : {}) })) };
}

export interface LogWriter {
  write(lines: readonly LogLine[]): void;
  /** Flushes and closes; resolves to the log path (even if writing failed). */
  close(): Promise<string>;
}

export function createLogWriter(cacheDir: string, runId: string, label: string, options: { maxBytes?: number } = {}): LogWriter {
  const file = path.join(cacheDir, "logs", `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  let stream: WriteStream | undefined;
  let failed = false;
  let bytes = 0;
  let truncated = false;
  const queue: string[] = [`# ${redact(label)} · started ${new Date().toISOString()}\n`];

  const ready = mkdir(path.dirname(file), { recursive: true }).then(
    () => {
      // O_EXCL ("wx"): never overwrites and never follows a planted symlink.
      stream = createWriteStream(file, { flags: "wx", mode: 0o600 });
      stream.on("error", () => {
        failed = true;
      });
      for (const chunk of queue.splice(0)) stream.write(chunk);
    },
    () => {
      failed = true;
    },
  );

  const push = (chunk: string): void => {
    if (failed) return;
    if (stream) stream.write(chunk);
    else queue.push(chunk);
  };

  return {
    write(lines) {
      if (truncated || failed) return;
      let chunk = "";
      for (const l of lines) {
        const text = `${PREFIX[l.stream]}${redact(l.text)}\n`;
        if (bytes + Buffer.byteLength(text) > maxBytes) {
          chunk += "# log truncated\n";
          truncated = true;
          break;
        }
        bytes += Buffer.byteLength(text);
        chunk += text;
      }
      if (chunk) push(chunk);
    },
    async close() {
      await ready;
      const s = stream;
      if (s && !s.destroyed) await new Promise<void>((resolve) => s.end(() => resolve()));
      return file;
    },
  };
}

export async function readLog(file: string, maxLines: number = MAX_MEMORY_LINES): Promise<LogLine[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines: LogLine[] = [];
  for (const row of rows.slice(1)) {
    const tag = row.slice(0, 2);
    lines.push({ stream: tag === "! " ? "stderr" : tag === "# " ? "system" : "stdout", text: row.slice(2) });
  }
  return lines.slice(-maxLines);
}

export function toHistoryEntry(run: RunRecord): HistoryEntry {
  return {
    id: run.id,
    commandId: run.commandId,
    label: run.label,
    status: run.status === "running" ? "cancelled" : run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs ?? 0,
    exitCode: run.exitCode ?? null,
    signal: run.signal ?? null,
    errorCount: run.errors.length,
    errors: run.errors.slice(0, MAX_HISTORY_ERRORS),
    ...(run.logFile ? { logFile: run.logFile } : {}),
  };
}

export function fromHistoryEntry(e: HistoryEntry): RunRecord {
  return {
    id: e.id,
    commandId: e.commandId,
    label: e.label,
    status: e.status,
    startedAt: e.startedAt,
    durationMs: e.durationMs,
    exitCode: e.exitCode,
    signal: e.signal,
    lines: [],
    droppedLines: 0,
    errors: e.errors,
    ...(e.logFile ? { logFile: e.logFile } : {}),
    fromHistory: true,
  };
}

export async function clearHistory(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
}

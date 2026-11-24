/**
 * Plugin interface and isolation.
 *
 * A plugin returns plain finding data; the host turns it into Findings. That
 * means a plugin can never forge the engine or id, skip redaction, or report
 * a file outside the scan scope. Running a plugin never throws: every outcome
 * is a PluginRunResult.
 *
 * Two isolation levels:
 *  - runPlugin(): in-process, for trusted built-in plugins. Errors are
 *    contained, a timeout aborts ctx.signal, output is validated.
 *  - runPluginModule(): a worker thread, for plugin modules. Adds a hard kill
 *    on timeout (even for a synchronous infinite loop), a heap limit, a
 *    minimal environment (no host secrets), separate globals and swallowed
 *    stdout/stderr, so a plugin cannot crash the scan or corrupt its output.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { type Finding, type FindingInput, createFinding } from "../finding.js";
import { redact } from "../redaction.js";
import type { Scope } from "../scope.js";

export type PluginFindingInput = Omit<FindingInput, "engine">;

export interface PluginContext {
  /** Canonical scan root. */
  readonly root: string;
  /** Aborted when the plugin times out; long-running work should stop. */
  readonly signal: AbortSignal;
}

export interface Plugin {
  readonly name: string;
  run(ctx: PluginContext): Promise<readonly PluginFindingInput[]> | readonly PluginFindingInput[];
}

export type PluginStatus = "ok" | "error" | "timeout" | "crashed" | "invalid-output";

export interface PluginRunResult {
  readonly name: string;
  readonly status: PluginStatus;
  readonly findings: readonly Finding[];
  /** Items the plugin returned that were invalid or outside the scope. */
  readonly skipped: number;
  /** True when output exceeded maxFindings and was cut. */
  readonly truncated: boolean;
  /** Redacted error description for non-ok statuses. */
  readonly error?: string;
  readonly durationMs: number;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly maxFindings?: number;
}

export interface ModuleRunOptions extends RunOptions {
  /** Heap limit for the worker (old generation), in MB. */
  readonly maxMemoryMb?: number;
  /** Environment visible to the plugin. Defaults to PATH only. */
  readonly env?: Readonly<Record<string, string>>;
}

export class PluginError extends Error {
  override readonly name = "PluginError";
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_FINDINGS = 10_000;
const DEFAULT_MAX_MEMORY_MB = 512;

export function definePlugin(plugin: Plugin): Plugin {
  if (typeof plugin?.name !== "string" || !NAME.test(plugin.name)) {
    throw new PluginError("plugin name must be 1-64 chars of a-z, 0-9, '.', '_' or '-'");
  }
  if (typeof plugin.run !== "function") throw new PluginError("plugin must have a run() function");
  return Object.freeze({ name: plugin.name, run: plugin.run.bind(plugin) });
}

const errorText = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

function result(name: string, start: number, status: PluginStatus, extra: Partial<PluginRunResult> = {}): PluginRunResult {
  return Object.freeze({
    name,
    status,
    findings: Object.freeze([...(extra.findings ?? [])]),
    skipped: extra.skipped ?? 0,
    truncated: extra.truncated ?? false,
    ...(extra.error === undefined ? {} : { error: extra.error }),
    durationMs: Math.max(0, performance.now() - start),
  });
}

/** Validates untrusted plugin output and converts it into host-owned Findings. */
async function collect(name: string, output: unknown, scope: Scope, start: number, maxFindings: number): Promise<PluginRunResult> {
  if (!Array.isArray(output)) return result(name, start, "invalid-output", { error: "plugin must return an array of findings" });

  const fileCache = new Map<string, string | null>();
  const toRelative = async (file: string): Promise<string | null> => {
    let rel = fileCache.get(file);
    if (rel === undefined) {
      rel = await scope.resolve(file).then(
        (real) => path.relative(scope.root, real).split(path.sep).join("/") || ".",
        () => null,
      );
      fileCache.set(file, rel);
    }
    return rel;
  };

  const findings: Finding[] = [];
  let skipped = 0;
  let truncated = false;
  for (let i = 0; i < output.length; i++) {
    if (findings.length >= maxFindings) {
      truncated = true;
      break;
    }
    const item: unknown = output[i];
    if (typeof item !== "object" || item === null) {
      skipped++;
      continue;
    }
    const raw = item as Record<string, unknown>;
    let file: string | undefined;
    if (raw.file !== undefined) {
      const rel = typeof raw.file === "string" && raw.file.length > 0 ? await toRelative(raw.file) : null;
      if (rel === null) {
        skipped++;
        continue;
      }
      file = rel;
    }
    try {
      findings.push(
        createFinding({
          engine: `plugin:${name}`,
          ruleId: raw.ruleId as string,
          severity: raw.severity as string,
          message: raw.message as string,
          file,
          line: raw.line as number | undefined,
          evidence: raw.evidence as string | undefined,
        }),
      );
    } catch {
      skipped++;
    }
  }
  return result(name, start, "ok", { findings, skipped, truncated });
}

const TIMED_OUT: unique symbol = Symbol("timeout");

/** Runs a trusted, in-process plugin. Never throws. */
export async function runPlugin(plugin: Plugin, scope: Scope, options: RunOptions = {}): Promise<PluginRunResult> {
  const start = performance.now();
  const controller = new AbortController();
  const ctx: PluginContext = Object.freeze({ root: scope.root, signal: controller.signal });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    const output = await Promise.race([Promise.resolve().then(() => plugin.run(ctx)), timeout]);
    if (output === TIMED_OUT) {
      controller.abort();
      return result(plugin.name, start, "timeout", { error: "plugin timed out" });
    }
    return await collect(plugin.name, output, scope, start, options.maxFindings ?? DEFAULT_MAX_FINDINGS);
  } catch (e) {
    controller.abort();
    return result(plugin.name, start, "error", { error: errorText(e) });
  } finally {
    clearTimeout(timer);
  }
}

// Plain JS evaluated inside the worker, so it works from both src (tests) and dist.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const text = (e) => (e && e.message) ? String(e.message) : String(e);
(async () => {
  let mod;
  try { mod = await import(workerData.url); }
  catch (e) { parentPort.postMessage({ type: "error", message: text(e) }); return; }
  const plugin = (mod && (mod.default || mod.plugin)) || null;
  if (!plugin || typeof plugin.name !== "string" || typeof plugin.run !== "function") {
    parentPort.postMessage({ type: "invalid", message: "module does not export a plugin" });
    return;
  }
  try {
    const signal = new AbortController().signal;
    const output = await plugin.run(Object.freeze({ root: workerData.root, signal }));
    parentPort.postMessage({ type: "result", name: plugin.name, output });
  } catch (e) {
    parentPort.postMessage({ type: "error", name: plugin.name, message: text(e) });
  }
})();
`;

/** Runs a plugin module in an isolated worker thread. Never throws. */
export function runPluginModule(modulePath: string, scope: Scope, options: ModuleRunOptions = {}): Promise<PluginRunResult> {
  const start = performance.now();
  let name = path.basename(String(modulePath)).replace(/\.[cm]?js$/, "");
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { url: pathToFileURL(path.resolve(modulePath)).href, root: scope.root },
        env: { ...(options.env ?? { PATH: process.env.PATH ?? "" }) },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: options.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB },
      });
    } catch (e) {
      resolve(result(name, start, "error", { error: errorText(e) }));
      return;
    }
    // Plugin console output must never reach the scan's own stdout/stderr.
    worker.stdout.resume();
    worker.stderr.resume();

    let settled = false;
    const settle = (outcome: PluginRunResult | Promise<PluginRunResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle(result(name, start, "timeout", { error: "plugin timed out and was terminated" })),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    worker.on("message", (msg: unknown) => {
      const m = (typeof msg === "object" && msg !== null ? msg : {}) as Record<string, unknown>;
      if (typeof m.name === "string" && NAME.test(m.name)) name = m.name;
      else if (m.name !== undefined) return settle(result(name, start, "invalid-output", { error: "plugin has an invalid name" }));

      if (m.type === "result") return settle(collect(name, m.output, scope, start, maxFindings));
      if (m.type === "invalid") return settle(result(name, start, "invalid-output", { error: String(m.message) }));
      return settle(result(name, start, "error", { error: redact(String(m.message ?? "plugin failed")) }));
    });
    worker.on("error", (e) => settle(result(name, start, "crashed", { error: errorText(e) })));
    worker.on("exit", (code) => settle(result(name, start, "crashed", { error: `plugin exited unexpectedly with code ${code}` })));
  });
}

/**
 * scan(): the one-call SDK. Creates the scope, runs the supply-chain engine
 * and all plugins concurrently, deduplicates findings by their
 * content-addressed id and returns a frozen, sorted result with the exit code
 * the CLI would use. Setup problems (bad target, unknown plugin) throw;
 * everything that happens during the scan is reported in the result.
 */
import { ConfigError, FAIL_ON, type FailOn } from "../cli/config.js";
import { type ExitCode, exitCodeFor } from "../cli/exit.js";
import { type Check, scanSupplyChain } from "../engines/supply-chain.js";
import type { Finding, Severity } from "../finding.js";
import { type Plugin, type PluginRunResult, runPlugin, runPluginModule } from "../plugins/base.js";
import { createSemgrepPlugin } from "../plugins/semgrep.js";
import { countBySeverity, sortFindings } from "../reporters/order.js";
import { type Scope, createScope } from "../scope.js";

/** A built-in plugin name, a trusted in-process plugin, or a module run in a worker. */
export type PluginSpec = string | Plugin | { readonly module: string };

export interface ScanOptions {
  /** Directory to scan. Defaults to the current directory. */
  readonly target?: string;
  readonly plugins?: readonly PluginSpec[];
  /** Supply-chain checks; defaults to the engine's built-in checks. */
  readonly checks?: readonly Check[];
  /** Lowest severity that makes exitCode FINDINGS. Defaults to "low". */
  readonly failOn?: FailOn;
  /** Per-plugin timeout in milliseconds. */
  readonly pluginTimeoutMs?: number;
}

export interface ScanResult {
  readonly root: string;
  readonly findings: readonly Finding[];
  readonly plugins: readonly PluginRunResult[];
  readonly summary: { readonly total: number; readonly bySeverity: Readonly<Record<Severity, number>> };
  readonly exitCode: ExitCode;
  readonly durationMs: number;
}

const BUILTIN_PLUGINS: Readonly<Record<string, () => Plugin>> = { semgrep: () => createSemgrepPlugin() };

/** Validated work for one scan; shared with the streaming variant. */
export interface ScanPlan {
  readonly scope: Scope;
  readonly failOn: FailOn;
  readonly engine: () => Promise<readonly Finding[]>;
  readonly plugins: readonly (() => Promise<PluginRunResult>)[];
}

export async function planScan(options: ScanOptions = {}): Promise<ScanPlan> {
  const failOn = options.failOn ?? "low";
  if (!(FAIL_ON as readonly string[]).includes(failOn)) throw new ConfigError(`failOn must be one of: ${FAIL_ON.join(", ")}`);

  const runOpts = options.pluginTimeoutMs === undefined ? {} : { timeoutMs: options.pluginTimeoutMs };
  // Resolve every plugin before touching the filesystem, so typos fail fast.
  const resolved = (options.plugins ?? []).map((spec): ((scope: Scope) => Promise<PluginRunResult>) => {
    if (typeof spec === "string") {
      const make = BUILTIN_PLUGINS[spec];
      if (!make) throw new ConfigError(`unknown plugin "${spec}"; available: ${Object.keys(BUILTIN_PLUGINS).join(", ")}`);
      return (scope) => runPlugin(make(), scope, runOpts);
    }
    if ("module" in spec) return (scope) => runPluginModule(spec.module, scope, runOpts);
    return (scope) => runPlugin(spec, scope, runOpts);
  });

  const scope = await createScope(options.target ?? ".");
  const checks = options.checks === undefined ? {} : { checks: options.checks };
  return Object.freeze({
    scope,
    failOn,
    engine: () => scanSupplyChain(scope, checks),
    plugins: resolved.map((run) => () => run(scope)),
  });
}

/** Keeps the first finding for each id. */
export function dedupeFindings(findings: Iterable<Finding>): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const start = performance.now();
  const plan = await planScan(options);
  const [engineFindings, pluginResults] = await Promise.all([plan.engine(), Promise.all(plan.plugins.map((run) => run()))]);

  const findings = Object.freeze(sortFindings(dedupeFindings([...engineFindings, ...pluginResults.flatMap((r) => r.findings)])));
  return Object.freeze({
    root: plan.scope.root,
    findings,
    plugins: Object.freeze(pluginResults),
    summary: Object.freeze({ total: findings.length, bySeverity: Object.freeze(countBySeverity(findings)) }),
    exitCode: exitCodeFor({ findings, failOn: plan.failOn, plugins: pluginResults }),
    durationMs: Math.max(0, performance.now() - start),
  });
}

/**
 * scanStream(): streaming variant of scan(). Yields findings as soon as each
 * source (the engine or a plugin) completes, so fast results are not held
 * back by slow plugins. Findings are deduplicated across sources, and the
 * final `end` event carries the same summary and exit code scan() returns.
 */
import { type ExitCode, exitCodeFor } from "../cli/exit.js";
import type { Finding, Severity } from "../finding.js";
import type { PluginRunResult } from "../plugins/base.js";
import { countBySeverity, sortFindings } from "../reporters/order.js";
import { type ScanOptions, planScan } from "./scan.js";

/** A plugin's outcome without its findings (those were already streamed). */
export type PluginSummary = Omit<PluginRunResult, "findings"> & { readonly findingCount: number };

export type ScanEvent =
  | { readonly type: "start"; readonly root: string }
  | { readonly type: "finding"; readonly finding: Finding }
  | { readonly type: "plugin"; readonly result: PluginSummary }
  | {
      readonly type: "end";
      readonly summary: { readonly total: number; readonly bySeverity: Readonly<Record<Severity, number>> };
      readonly exitCode: ExitCode;
      readonly durationMs: number;
    };

type Completed =
  | { readonly key: number; readonly kind: "engine"; readonly findings: readonly Finding[] }
  | { readonly key: number; readonly kind: "plugin"; readonly result: PluginRunResult };

export async function* scanStream(options: ScanOptions = {}): AsyncGenerator<ScanEvent, void, undefined> {
  const start = performance.now();
  const plan = await planScan(options);
  yield { type: "start", root: plan.scope.root };

  const pending = new Map<number, Promise<Completed>>();
  pending.set(0, plan.engine().then((findings) => ({ key: 0, kind: "engine" as const, findings })));
  plan.plugins.forEach((run, i) => pending.set(i + 1, run().then((result) => ({ key: i + 1, kind: "plugin" as const, result }))));
  // If the consumer stops early, late failures must not become unhandled rejections.
  for (const p of pending.values()) p.catch(() => undefined);

  const seen = new Set<string>();
  const findings: Finding[] = [];
  const pluginResults: PluginRunResult[] = [];

  while (pending.size > 0) {
    const done = await Promise.race(pending.values());
    pending.delete(done.key);

    for (const finding of sortFindings(done.kind === "engine" ? done.findings : done.result.findings)) {
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      findings.push(finding);
      yield { type: "finding", finding };
    }
    if (done.kind === "plugin") {
      pluginResults.push(done.result);
      const { findings: pluginFindings, ...rest } = done.result;
      yield { type: "plugin", result: Object.freeze({ ...rest, findingCount: pluginFindings.length }) };
    }
  }

  yield {
    type: "end",
    summary: Object.freeze({ total: findings.length, bySeverity: Object.freeze(countBySeverity(findings)) }),
    exitCode: exitCodeFor({ findings, failOn: plan.failOn, plugins: pluginResults }),
    durationMs: Math.max(0, performance.now() - start),
  };
}

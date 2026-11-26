/**
 * Semgrep plugin: spawns the `semgrep` CLI and maps its JSON output to
 * plugin findings. Offline-first: only local rule configs are allowed
 * (registry configs like `auto` or `p/...` fetch rules over the network),
 * and metrics and version checks are always disabled. The child is spawned
 * without a shell, its output is size-capped, and it is killed when the
 * scan aborts (timeout). The binary is resolved to an absolute path that is
 * never inside the scanned tree, and the child runs with a cwd outside it
 * (issue #47).
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { type Plugin, type PluginFindingInput, PluginError, definePlugin } from "./base.js";
import { neutralCwd, resolveExecutable } from "./exec.js";

export interface SemgrepOptions {
  /**
   * Path or name of the semgrep executable. A bare name is looked up on the
   * child's PATH, skipping empty/relative entries and anything inside the scan
   * root; a path is used as given (resolved against the process cwd).
   */
  readonly binary?: string;
  /** Local rule files/directories, relative to the scan root. Defaults to .semgrep.yml / .semgrep.yaml / .semgrep/. */
  readonly configs?: readonly string[];
  /** Environment for the child process. Defaults to PATH only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Maximum bytes of JSON accepted on stdout. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_CONFIGS = [".semgrep.yml", ".semgrep.yaml", ".semgrep"] as const;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
const NETWORK_CONFIG = /^(auto$|[prs]\/|https?:\/\/)/i;

const SEVERITY: Readonly<Record<string, PluginFindingInput["severity"]>> = {
  CRITICAL: "critical",
  ERROR: "high",
  HIGH: "high",
  WARNING: "medium",
  MEDIUM: "medium",
  INFO: "low",
  LOW: "low",
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function mapSemgrepOutput(json: unknown): PluginFindingInput[] {
  const results = obj(json)?.results;
  if (!Array.isArray(results)) throw new PluginError("unexpected semgrep output: missing results array");
  const out: PluginFindingInput[] = [];
  for (const r of results) {
    const result = obj(r);
    const ruleId = str(result?.check_id);
    if (!result || !ruleId) continue;
    const extra = obj(result.extra) ?? {};
    const line = obj(result.start)?.line;
    out.push({
      ruleId,
      severity: SEVERITY[String(extra.severity ?? "").toUpperCase()] ?? "info",
      message: str(extra.message) ?? ruleId,
      file: str(result.path),
      line: typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : undefined,
      evidence: str(extra.lines),
    });
  }
  return out;
}

export function semgrepArgs(configs: readonly string[], root: string): string[] {
  return ["scan", "--json", "--quiet", "--metrics=off", "--disable-version-check", ...configs.flatMap((c) => ["--config", c]), root];
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

async function resolveConfigs(root: string, configs: readonly string[] | undefined): Promise<string[]> {
  if (configs !== undefined) {
    for (const c of configs) {
      if (NETWORK_CONFIG.test(c)) throw new PluginError(`semgrep config "${c}" needs the network; only local configs are allowed`);
    }
    return configs.map((c) => path.resolve(root, c));
  }
  for (const candidate of DEFAULT_CONFIGS) {
    const p = path.join(root, candidate);
    if (await exists(p)) return [p];
  }
  throw new PluginError(`no local semgrep config found (expected one of ${DEFAULT_CONFIGS.join(", ")})`);
}

function runSemgrep(binary: string, args: string[], cwd: string, env: Readonly<Record<string, string>>, signal: AbortSignal, maxOutputBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...env }, signal, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, killSignal: "SIGKILL" });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let failed = false;
    const fail = (e: Error): void => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(e);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) return fail(new PluginError(`semgrep output exceeded ${maxOutputBytes} bytes`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(e.code === "ENOENT" ? new PluginError(`semgrep is not installed (binary not found: ${binary})`) : e);
    });
    child.on("close", (code) => {
      if (failed) return;
      // Without --error, semgrep exits 0 with findings; 1 is also tolerated.
      if (code !== 0 && code !== 1) return fail(new PluginError(`semgrep exited with code ${code}: ${stderr.trim()}`));
      failed = true;
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export function createSemgrepPlugin(options: SemgrepOptions = {}): Plugin {
  return definePlugin({
    name: "semgrep",
    async run(ctx) {
      const configs = await resolveConfigs(ctx.root, options.configs);
      const env = options.env ?? { PATH: process.env.PATH ?? "" };
      const name = options.binary ?? "semgrep";
      const binary = await resolveExecutable(name, { pathEnv: env.PATH, root: ctx.root });
      if (binary === undefined) throw new PluginError(`semgrep is not installed (binary not found on PATH: ${name})`);
      const raw = await runSemgrep(
        binary,
        semgrepArgs(configs, ctx.root),
        neutralCwd(),
        env,
        ctx.signal,
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new PluginError("semgrep produced invalid JSON output");
      }
      return mapSemgrepOutput(json);
    },
  });
}

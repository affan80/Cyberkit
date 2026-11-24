/**
 * Supply-chain engine: offline checks over a project's package.json.
 * The manifest is read through a Scope, so it cannot be redirected outside
 * the scan target. Checks are plain functions, so new ones (e.g. typosquat
 * detection) plug in without touching the engine.
 */
import { access, readFile, stat } from "node:fs/promises";
import { type Finding, type FindingInput, createFinding } from "../finding.js";
import type { Scope } from "../scope.js";
import { createTyposquatCheck } from "./typosquat.js";

export const ENGINE = "supply-chain";
const MANIFEST = "package.json";
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"] as const;
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export interface Dep {
  readonly name: string;
  readonly spec: string;
  readonly section: (typeof SECTIONS)[number];
}

export interface Manifest {
  readonly raw: string;
  readonly deps: readonly Dep[];
  readonly hasLockfile: boolean;
}

export interface CheckResult {
  readonly ruleId: string;
  readonly severity: FindingInput["severity"];
  readonly message: string;
  readonly dep?: Dep;
}

export type Check = (manifest: Manifest) => readonly CheckResult[];

export interface SupplyChainOptions {
  readonly checks?: readonly Check[];
}

/** Masks URL userinfo (except the ordinary `git@` ssh user) so credentials never reach a message. */
const maskCredentials = (spec: string): string => spec.replace(/(:\/\/)(?!git@)[^/\s@]+@/g, "$1[REDACTED]@");

const WILDCARD = /^(\*|latest|x|X|>=\s*0(\.0){0,2})?$/;
const GIT_PREFIX = /^(git\+[a-z]+|git|github|gitlab|bitbucket|gist):/i;
const GIT_SHORTHAND = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(#.+)?$/;
const INSECURE = /^(git\+)?http:\/\/|^git:\/\//i;
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;
const HTTP_TOKEN = /^(git\+)?https?:\/\/[^/\s:@]+@/i;

const isGit = (spec: string): boolean => GIT_PREFIX.test(spec) || GIT_SHORTHAND.test(spec);
const hasPinnedRef = (spec: string): boolean => /#.+/.test(spec);
const describeDep = (d: Dep): string => `${d.name}@${maskCredentials(d.spec)} (${d.section})`;

export const defaultChecks: readonly Check[] = [
  (m) =>
    m.deps
      .filter((d) => WILDCARD.test(d.spec.trim()))
      .map((dep) => ({ ruleId: "wildcard-version", severity: "medium", message: `${describeDep(dep)} accepts any version`, dep })),
  (m) =>
    m.deps
      .filter((d) => INSECURE.test(d.spec))
      .map((dep) => ({ ruleId: "insecure-source", severity: "high", message: `${describeDep(dep)} is fetched over an insecure protocol`, dep })),
  (m) =>
    m.deps
      .filter((d) => URL_PASSWORD.test(d.spec) || HTTP_TOKEN.test(d.spec))
      .map((dep) => ({ ruleId: "credentials-in-url", severity: "high", message: `${describeDep(dep)} embeds credentials in its URL`, dep })),
  (m) =>
    m.deps
      .filter((d) => isGit(d.spec) && !hasPinnedRef(d.spec))
      .map((dep) => ({ ruleId: "unpinned-git-dependency", severity: "medium", message: `${describeDep(dep)} is not pinned to a commit or tag`, dep })),
  (m) =>
    m.deps.length > 0 && !m.hasLockfile
      ? [{ ruleId: "missing-lockfile", severity: "low", message: "dependencies are declared but no lockfile was found" }]
      : [],
  createTyposquatCheck(),
];

function parseDeps(json: unknown): Dep[] | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const root = json as Record<string, unknown>;
  const deps: Dep[] = [];
  for (const section of SECTIONS) {
    const entries = root[section];
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec === "string") deps.push({ name, spec, section });
    }
  }
  return deps;
}

/** Maps a character offset to a 1-based line with a binary search over precomputed line starts. */
function makeLineLocator(raw: string): (offset: number) => number {
  const starts = [0];
  for (let i = raw.indexOf("\n"); i !== -1; i = raw.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function makeDepLocator(raw: string): (dep: Dep) => number | undefined {
  const lineAt = makeLineLocator(raw);
  return (dep) => {
    const sectionAt = raw.indexOf(JSON.stringify(dep.section));
    if (sectionAt === -1) return undefined;
    const key = JSON.stringify(dep.name);
    for (let i = raw.indexOf(key, sectionAt); i !== -1; i = raw.indexOf(key, i + 1)) {
      if (/^\s*:/.test(raw.slice(i + key.length, i + key.length + 8))) return lineAt(i);
    }
    return undefined;
  };
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

const invalid = (message: string): Finding =>
  createFinding({ engine: ENGINE, ruleId: "invalid-manifest", severity: "low", message, file: MANIFEST });

export async function scanSupplyChain(scope: Scope, options: SupplyChainOptions = {}): Promise<readonly Finding[]> {
  const manifestPath = await scope.resolve(MANIFEST);
  let size: number;
  try {
    size = (await stat(manifestPath)).size;
  } catch {
    return []; // no manifest: nothing to check
  }
  if (size > MAX_MANIFEST_BYTES) return [invalid(`${MANIFEST} is larger than ${MAX_MANIFEST_BYTES} bytes and was not parsed`)];

  const raw = await readFile(manifestPath, "utf8");
  let deps: Dep[] | undefined;
  try {
    deps = parseDeps(JSON.parse(raw));
  } catch {
    return [invalid(`${MANIFEST} is not valid JSON`)];
  }
  if (deps === undefined) return [invalid(`${MANIFEST} must contain a JSON object`)];

  const lockChecks = await Promise.all(LOCKFILES.map(async (name) => exists(await scope.resolve(name))));
  const manifest: Manifest = { raw, deps, hasLockfile: lockChecks.some(Boolean) };

  const locate = makeDepLocator(raw);
  const findings: Finding[] = [];
  for (const check of options.checks ?? defaultChecks) {
    for (const r of check(manifest)) {
      findings.push(
        createFinding({
          engine: ENGINE,
          ruleId: r.ruleId,
          severity: r.severity,
          message: r.message,
          file: MANIFEST,
          line: r.dep ? locate(r.dep) : undefined,
          evidence: r.dep ? `"${r.dep.name}": "${maskCredentials(r.dep.spec)}"` : undefined,
        }),
      );
    }
  }
  return findings;
}

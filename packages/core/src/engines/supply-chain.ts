/**
 * Supply-chain engine: offline checks over a project's package.json.
 * The manifest is read through a Scope, so it cannot be redirected outside
 * the scan target. Checks are plain functions, so new ones (e.g. typosquat
 * detection) plug in without touching the engine.
 */
import { access } from "node:fs/promises";
import { type Finding, type FindingInput, createFinding } from "../finding.js";
import { FileTooLargeError } from "../safe-read.js";
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

/**
 * Offsets of every key in each top-level dependency section, from ONE linear
 * pass over the manifest (#53). The old locator re-searched from the start of
 * the section for every flagged dependency: O(k x section size).
 *
 * The input is valid JSON (JSON.parse already accepted it), so a small
 * scanner is enough. It decodes keys (so escaped names match), ignores
 * "dependencies" appearing anywhere but as a top-level key, and keeps the
 * last duplicate key, like JSON.parse does.
 */
function indexDependencyKeys(raw: string): Map<string, Map<string, number>> {
  const sections = new Set<string>(SECTIONS);
  const index = new Map<string, Map<string, number>>();
  const stack: number[] = []; // open brackets: 0x7b "{" or 0x5b "["
  let expectKey = false;
  let topKey: string | undefined; // last key read in the root object
  let section: Map<string, number> | undefined; // the dependency section being indexed

  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x22) {
      const start = i;
      for (i++; i < raw.length; i++) {
        const d = raw.charCodeAt(i);
        if (d === 0x5c) i++;
        else if (d === 0x22) break;
      }
      if (expectKey && (stack.length === 1 || (stack.length === 2 && section))) {
        const name = JSON.parse(raw.slice(start, i + 1)) as string;
        if (stack.length === 1) topKey = name;
        else section?.set(name, start);
      }
      expectKey = false;
    } else if (c === 0x7b) {
      stack.push(c);
      expectKey = true;
      if (stack.length === 2 && stack[0] === 0x7b && topKey !== undefined && sections.has(topKey)) {
        section = new Map();
        index.set(topKey, section); // a later duplicate section replaces it, like JSON.parse
      }
    } else if (c === 0x5b) {
      stack.push(c);
      expectKey = false;
    } else if (c === 0x7d || c === 0x5d) {
      stack.pop();
      if (stack.length < 2) section = undefined;
      expectKey = false;
    } else if (c === 0x2c) {
      expectKey = stack[stack.length - 1] === 0x7b;
    }
  }
  return index;
}

function makeDepLocator(raw: string): (dep: Dep) => number | undefined {
  const lineAt = makeLineLocator(raw);
  const index = indexDependencyKeys(raw);
  return (dep) => {
    const offset = index.get(dep.section)?.get(dep.name);
    return offset === undefined ? undefined : lineAt(offset);
  };
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

const invalid = (message: string): Finding =>
  createFinding({ engine: ENGINE, ruleId: "invalid-manifest", severity: "low", message, file: MANIFEST });

export async function scanSupplyChain(scope: Scope, options: SupplyChainOptions = {}): Promise<readonly Finding[]> {
  if (scope.isExcluded(MANIFEST)) return []; // excluded by the scope configuration
  // One descriptor for the scope check, size cap and read (no TOCTOU, #51).
  let raw: string;
  try {
    raw = await scope.readFile(MANIFEST, { maxBytes: MAX_MANIFEST_BYTES });
  } catch (e) {
    if (e instanceof FileTooLargeError) return [invalid(`${MANIFEST} is larger than ${MAX_MANIFEST_BYTES} bytes and was not parsed`)];
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return []; // no manifest: nothing to check
    throw e;
  }
  let deps: Dep[] | undefined;
  try {
    deps = parseDeps(JSON.parse(raw));
  } catch {
    return [invalid(`${MANIFEST} is not valid JSON`)];
  }
  if (deps === undefined) return [invalid(`${MANIFEST} must contain a JSON object`)];

  // An excluded lockfile counts as absent.
  const lockChecks = await Promise.all(LOCKFILES.map((name) => scope.resolve(name).then(exists, () => false)));
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

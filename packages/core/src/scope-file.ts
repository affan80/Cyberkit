/**
 * Scope files: an optional `.cyberkit/scope.json` in the scan root that
 * narrows what a scan may touch with root-relative include/exclude globs.
 * The format is documented in docs/SCOPE.md and docs/scope.schema.json; a
 * test keeps that schema and this validator in agreement.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./cli/config.js";

export const SCOPE_FILE = ".cyberkit/scope.json";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATTERNS = 1000;
const MAX_PATTERN_LENGTH = 1024;
const KNOWN_KEYS = new Set(["$schema", "version", "include", "exclude"]);

/** Invalid scope configuration. A ConfigError, so the CLI exits with USAGE (2). */
export class ScopeFileError extends ConfigError {
  override readonly name = "ScopeFileError";
}

export interface ScopeConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

const EMPTY: ScopeConfig = Object.freeze({ include: Object.freeze([]), exclude: Object.freeze([]) });

function validatePattern(value: unknown): string {
  const show = JSON.stringify(value)?.slice(0, 80);
  if (typeof value !== "string" || value.length === 0) throw new ScopeFileError(`invalid scope pattern ${show}: must be a non-empty string`);
  if (value.length > MAX_PATTERN_LENGTH) throw new ScopeFileError(`invalid scope pattern ${show}: longer than ${MAX_PATTERN_LENGTH} characters`);
  if (value.includes("\0") || value.includes("\\")) throw new ScopeFileError(`invalid scope pattern ${show}: use "/" separators and no NUL bytes`);
  if (value.startsWith("/")) throw new ScopeFileError(`invalid scope pattern ${show}: must be relative to the scan root`);
  if (value.split("/").includes("..")) throw new ScopeFileError(`invalid scope pattern ${show}: ".." is not allowed`);
  return value;
}

function patternList(value: unknown, key: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new ScopeFileError(`scope "${key}" must be an array of patterns`);
  if (value.length > MAX_PATTERNS) throw new ScopeFileError(`scope "${key}" has more than ${MAX_PATTERNS} patterns`);
  return Object.freeze(value.map(validatePattern));
}

/** Validates an untrusted, already-parsed scope config. */
export function parseScopeConfig(value: unknown): ScopeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ScopeFileError("scope config must be a JSON object");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) throw new ScopeFileError(`unknown scope config key "${key}"`);
  }
  if (obj.version !== 1) throw new ScopeFileError('scope config must have "version": 1');
  return Object.freeze({ include: patternList(obj.include, "include"), exclude: patternList(obj.exclude, "exclude") });
}

/** Loads `<root>/.cyberkit/scope.json` if present. `root` must already be canonical. */
export async function loadScopeFile(root: string): Promise<ScopeConfig> {
  const file = path.join(root, SCOPE_FILE);
  let real: string;
  try {
    real = await realpath(file);
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return EMPTY;
    throw new ScopeFileError(`${SCOPE_FILE}: cannot be read`);
  }
  const rel = path.relative(root, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ScopeFileError(`${SCOPE_FILE} must not point outside the scan root`);
  }
  if ((await stat(real)).size > MAX_FILE_BYTES) throw new ScopeFileError(`${SCOPE_FILE} is larger than ${MAX_FILE_BYTES} bytes`);

  let json: unknown;
  try {
    json = JSON.parse(await readFile(real, "utf8"));
  } catch {
    throw new ScopeFileError(`${SCOPE_FILE}: invalid JSON`);
  }
  try {
    return parseScopeConfig(json);
  } catch (e) {
    throw new ScopeFileError(`${SCOPE_FILE}: ${e instanceof Error ? e.message : "invalid"}`);
  }
}

export interface GlobMatcher {
  /** Tests a root-relative POSIX path. */
  test(relPath: string): boolean;
}

/** Wildcard match within one path segment (`*`, `?`); greedy two-pointer, no backtracking blow-up. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Compiles a glob: `*` and `?` stay within one segment, `**` spans any number
 * of segments (including none). A trailing `/` is ignored. Matching is
 * memoised over (pattern segment, path segment), so it is polynomial even for
 * hostile patterns.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const pat = pattern.replace(/\/+$/, "").split("/");
  return {
    test(relPath: string): boolean {
      const parts = relPath.split("/");
      const memo = new Map<number, boolean>();
      const match = (pi: number, si: number): boolean => {
        const key = pi * (parts.length + 1) + si;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        let result: boolean;
        if (pi === pat.length) result = si === parts.length;
        else if (pat[pi] === "**") result = match(pi + 1, si) || (si < parts.length && match(pi, si + 1));
        else result = si < parts.length && matchSegment(pat[pi] as string, parts[si] as string) && match(pi + 1, si + 1);
        memo.set(key, result);
        return result;
      };
      return match(0, 0);
    },
  };
}

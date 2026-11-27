/**
 * Scope files: an optional `.cyberkit/scope.json` in the scan root that
 * narrows what a scan may touch with root-relative include/exclude globs.
 * The format is documented in docs/SCOPE.md and docs/scope.schema.json; a
 * test keeps that schema and this validator in agreement.
 */
import { realpath } from "node:fs/promises";
import { FileTooLargeError, readFileAtomic } from "./safe-read.js";
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
  let text: string;
  try {
    text = await readFileAtomic(real, MAX_FILE_BYTES); // no TOCTOU between the check above and the read (#51)
  } catch (e) {
    if (e instanceof FileTooLargeError) throw new ScopeFileError(`${SCOPE_FILE} is larger than ${MAX_FILE_BYTES} bytes`);
    throw new ScopeFileError(`${SCOPE_FILE}: cannot be read`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
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

/** Reusable DP table, grown on demand: no allocation per match (#54). */
let table = new Uint8Array(256);

/**
 * Whether glob segments `pat` match path segments `parts` exactly. Bottom-up
 * DP over (pattern segment, path segment): O(|pat| x |parts|) segment tests,
 * polynomial even for hostile patterns, with no recursion or per-call Map.
 */
function matchSegments(pat: readonly string[], parts: readonly string[]): boolean {
  const m = pat.length;
  const n = parts.length;
  const width = n + 1;
  const size = (m + 1) * width;
  if (table.length < size) table = new Uint8Array(Math.max(size, table.length * 2));
  const dp = table;
  for (let si = 0; si < n; si++) dp[m * width + si] = 0;
  dp[m * width + n] = 1;
  for (let pi = m - 1; pi >= 0; pi--) {
    const seg = pat[pi] as string;
    const row = pi * width;
    const next = row + width;
    for (let si = n; si >= 0; si--) {
      if (seg === "**") dp[row + si] = dp[next + si] || (si < n && dp[row + si + 1]) ? 1 : 0;
      else dp[row + si] = si < n && dp[next + si + 1] && matchSegment(seg, parts[si] as string) ? 1 : 0;
    }
  }
  return dp[0] === 1;
}

const segmentsOf = (pattern: string): string[] => pattern.replace(/\/+$/, "").split("/");

/**
 * Compiles a glob: `*` and `?` stay within one segment, `**` spans any number
 * of segments (including none). A trailing `/` is ignored.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const pat = segmentsOf(pattern);
  return { test: (relPath: string): boolean => matchSegments(pat, relPath.split("/")) };
}

export interface GlobSetMatcher {
  /** Whether the path, or any directory above it, matches at least one pattern. */
  matchesSelfOrAncestor(parts: readonly string[]): boolean;
}

/**
 * 64-bit "which characters occur" signature (code % 64) as [low, high] 32-bit
 * halves. A segment glob can only match text containing all of its literal
 * characters, so comparing signatures rejects most pairs in a couple of ns.
 */
function charSignature(text: string, skipWildcards: boolean): [number, number] {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (skipWildcards && (c === 0x2a || c === 0x3f)) continue; // "*" "?"
    const bit = c & 63;
    if (bit < 32) lo |= 1 << bit;
    else hi |= 1 << (bit - 32);
  }
  return [lo, hi];
}

/** Paths up to this depth use the bitset matcher (positions 0..depth fit in 31 bits). */
const BITSET_MAX_DEPTH = 30;

/**
 * Compiles a pattern list for "this path or one of its ancestors matches"
 * queries (#54). Per path:
 * - a pattern matches some ancestor-or-self iff `pattern/**` matches the path,
 *   so each pattern is tested once, not once per directory prefix;
 * - patterns without wildcards are a Set lookup per prefix, O(depth);
 * - wildcard patterns run as a bitset NFA over path positions: one bitwise step
 *   per pattern segment. Each distinct pattern segment is tested at most once
 *   per distinct path segment (repo paths repeat names like "src"), memoised
 *   in a reused typed array.
 */
export function compileGlobSet(patterns: readonly string[]): GlobSetMatcher {
  const literals = new Set<string>();
  const globs: string[][] = [];
  const segIds = new Map<string, number>();
  const segs: string[] = [];
  const compiled: Int32Array[] = []; // per glob: segment ids, -1 for "**"
  for (const pattern of patterns) {
    const pat = segmentsOf(pattern);
    if (!pat.some((seg) => seg.includes("*") || seg.includes("?"))) {
      literals.add(pat.join("/"));
      continue;
    }
    const full = [...pat, "**"];
    globs.push(full);
    compiled.push(
      Int32Array.from(full, (seg) => {
        if (seg === "**") return -1;
        let id = segIds.get(seg);
        if (id === undefined) {
          id = segs.length;
          segs.push(seg);
          segIds.set(seg, id);
        }
        return id;
      }),
    );
  }
  const segSigs = segs.map((seg) => charSignature(seg, true));
  let memo = new Uint8Array(0); // [segId * uniqueCount + u]: 0 unknown, 1 no, 2 yes

  const matchBitset = (parts: readonly string[]): boolean => {
    const n = parts.length;
    const full = (1 << (n + 1)) - 1;
    // Distinct path segments and the positions where each occurs.
    const uniqueOf = new Map<string, number>();
    const uniques: string[] = [];
    const positions: number[] = [];
    for (let si = 0; si < n; si++) {
      const part = parts[si] as string;
      let u = uniqueOf.get(part);
      if (u === undefined) {
        u = uniques.length;
        uniqueOf.set(part, u);
        uniques.push(part);
        positions.push(0);
      }
      positions[u] = (positions[u] as number) | (1 << si);
    }
    const k = uniques.length;
    const partSigs = uniques.map((part) => charSignature(part, false));
    const size = segs.length * k;
    if (memo.length < size) memo = new Uint8Array(Math.max(size, memo.length * 2));
    else memo.fill(0, 0, size);

    for (const pat of compiled) {
      let state = 1; // bit si: pattern prefix consumed parts[0..si)
      for (let pi = 0; pi < pat.length && state !== 0; pi++) {
        const id = pat[pi] as number;
        if (id === -1) {
          state = (state | -(state & -state)) & full; // "**": every position from the lowest reachable one
          continue;
        }
        let mask = 0;
        const row = id * k;
        for (let u = 0; u < k; u++) {
          let known = memo[row + u] as number;
          if (known === 0) {
            const [slo, shi] = segSigs[id] as [number, number];
            const [plo, phi] = partSigs[u] as [number, number];
            const possible = ((slo & ~plo) | (shi & ~phi)) === 0;
            known = possible && matchSegment(segs[id] as string, uniques[u] as string) ? 2 : 1;
            memo[row + u] = known;
          }
          if (known === 2) mask |= positions[u] as number;
        }
        state = ((state & mask) << 1) & full;
      }
      if ((state >>> n) & 1) return true;
    }
    return false;
  };

  return {
    matchesSelfOrAncestor(parts) {
      if (parts.length === 0) return false;
      if (literals.size > 0) {
        let prefix = "";
        for (const part of parts) {
          prefix = prefix === "" ? part : `${prefix}/${part}`;
          if (literals.has(prefix)) return true;
        }
      }
      if (globs.length === 0) return false;
      if (parts.length <= BITSET_MAX_DEPTH) return matchBitset(parts);
      for (const pat of globs) if (matchSegments(pat, parts)) return true;
      return false;
    },
  };
}

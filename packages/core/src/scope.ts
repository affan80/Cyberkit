/**
 * Scope: the set of files a scan may touch, anchored at one root directory.
 *
 * Every path is canonicalised with realpath before the containment check, so
 * `..` segments and symlinks cannot be used to escape. Paths that do not exist
 * yet are resolved through their nearest existing ancestor. Offline, no deps.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readFileAtomic } from "./safe-read.js";
import { compileGlobSet, loadScopeFile, parseScopeConfig } from "./scope-file.js";

export class ScopeError extends Error {
  override readonly name = "ScopeError";
}

export interface Scope {
  /** Canonical (realpath) root directory. */
  readonly root: string;
  /** Canonical absolute path for `input`, or throws ScopeError if it is outside the scope. */
  resolve(input: string): Promise<string>;
  /**
   * Reads an in-scope file as UTF-8 through a single descriptor, so the file
   * that was checked is the file that is read (no symlink swap in between) and
   * at most `maxBytes` are ever read. Throws ScopeError when the path is out of
   * scope, FileTooLargeError over the cap, UnsafeReadError if the file changed
   * while being opened, and the usual ENOENT error when it doesn't exist.
   */
  readFile(input: string, options: { readonly maxBytes: number }): Promise<string>;
  /** Like resolve(), but returns a boolean and never throws. */
  contains(input: string): Promise<boolean>;
  /** Effective include patterns (empty means everything). */
  readonly include: readonly string[];
  /** Effective exclude patterns. */
  readonly exclude: readonly string[];
  /** Whether a root-relative POSIX path is excluded by include/exclude (no filesystem access). */
  isExcluded(relPath: string): boolean;
}

export interface ScopeOptions {
  /** Only these root-relative globs (and everything beneath a match) are in scope. Overrides the scope file's include. */
  readonly include?: readonly string[];
  /** Root-relative globs to exclude, added to the scope file's excludes. */
  readonly exclude?: readonly string[];
  /** Read `.cyberkit/scope.json` from the root (default: true). */
  readonly scopeFile?: boolean;
}

const isMissing = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR");

function assertPathString(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScopeError(`${what} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new ScopeError(`${what} must not contain NUL bytes`);
  }
}

/** realpath that tolerates a not-yet-existing tail, but never a dangling symlink. */
async function realpathLoose(abs: string): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (e) {
      if (!isMissing(e)) throw new ScopeError("path cannot be resolved");
    }
    // realpath failed with "missing": distinguish truly absent from a dangling symlink.
    const exists = await lstat(current).then(
      () => true,
      () => false,
    );
    if (exists) throw new ScopeError("dangling symlink is not allowed");
    const parent = path.dirname(current);
    if (parent === current) throw new ScopeError("path cannot be resolved");
    tail.push(path.basename(current));
    current = parent;
  }
}

export async function createScope(rootInput: string, options: ScopeOptions = {}): Promise<Scope> {
  assertPathString(rootInput, "scope root");
  let root: string;
  try {
    root = await realpath(path.resolve(rootInput));
    if (!(await stat(root)).isDirectory()) throw new ScopeError("scope root must be a directory");
  } catch (e) {
    if (e instanceof ScopeError) throw e;
    throw new ScopeError("scope root does not exist or is not accessible");
  }

  const fromFile = options.scopeFile === false ? { include: [], exclude: [] } : await loadScopeFile(root);
  const explicit = parseScopeConfig({ version: 1, include: options.include ?? [], exclude: options.exclude ?? [] });
  const include = Object.freeze([...(options.include === undefined ? fromFile.include : explicit.include)]);
  const exclude = Object.freeze([...fromFile.exclude, ...explicit.exclude]);
  const includeSet = compileGlobSet(include);
  const excludeSet = compileGlobSet(exclude);

  // A path is excluded if it, or any directory above it, matches an exclude;
  // with includes, it (or a directory above it) must match an include. Each
  // pattern is tested once per path, and recent answers are cached (#54).
  const cache = new Map<string, boolean>();
  const CACHE_LIMIT = 10_000;
  const isExcluded = (relPath: string): boolean => {
    const cached = cache.get(relPath);
    if (cached !== undefined) return cached;
    const parts = relPath.split("/").filter((p) => p !== "" && p !== ".");
    const excluded =
      parts.length > 0 && // the root itself is always in scope
      (excludeSet.matchesSelfOrAncestor(parts) || (include.length > 0 && !includeSet.matchesSelfOrAncestor(parts)));
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(relPath, excluded);
    return excluded;
  };

  const inside = (real: string): boolean => {
    const rel = path.relative(root, real);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };

  const resolve = async (input: string): Promise<string> => {
    assertPathString(input, "path");
    const real = await realpathLoose(path.resolve(root, input));
    if (!inside(real)) throw new ScopeError("path is outside the scan scope");
    if (isExcluded(path.relative(root, real).split(path.sep).join("/"))) throw new ScopeError("path is excluded by the scope configuration");
    return real;
  };

  const contains = (input: string): Promise<boolean> =>
    resolve(input).then(
      () => true,
      () => false,
    );

  const readFile = async (input: string, options: { readonly maxBytes: number }): Promise<string> =>
    readFileAtomic(await resolve(input), options.maxBytes);

  return Object.freeze({ root, resolve, contains, readFile, include, exclude, isExcluded });
}

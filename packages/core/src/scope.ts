/**
 * Scope: the set of files a scan may touch, anchored at one root directory.
 *
 * Every path is canonicalised with realpath before the containment check, so
 * `..` segments and symlinks cannot be used to escape. Paths that do not exist
 * yet are resolved through their nearest existing ancestor. Offline, no deps.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { compileGlob, loadScopeFile, parseScopeConfig } from "./scope-file.js";

export class ScopeError extends Error {
  override readonly name = "ScopeError";
}

export interface Scope {
  /** Canonical (realpath) root directory. */
  readonly root: string;
  /** Canonical absolute path for `input`, or throws ScopeError if it is outside the scope. */
  resolve(input: string): Promise<string>;
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
  const includeMatchers = include.map(compileGlob);
  const excludeMatchers = exclude.map(compileGlob);

  // A path is excluded if it, or any directory above it, matches an exclude;
  // with includes, it (or a directory above it) must match an include.
  const isExcluded = (relPath: string): boolean => {
    const parts = relPath.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0) return false; // the root itself is always in scope
    let included = includeMatchers.length === 0;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (excludeMatchers.some((m) => m.test(prefix))) return true;
      if (!included && includeMatchers.some((m) => m.test(prefix))) included = true;
    }
    return !included;
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

  return Object.freeze({ root, resolve, contains, include, exclude, isExcluded });
}

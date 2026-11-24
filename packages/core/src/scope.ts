/**
 * Scope: the set of files a scan may touch, anchored at one root directory.
 *
 * Every path is canonicalised with realpath before the containment check, so
 * `..` segments and symlinks cannot be used to escape. Paths that do not exist
 * yet are resolved through their nearest existing ancestor. Offline, no deps.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

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

export async function createScope(rootInput: string): Promise<Scope> {
  assertPathString(rootInput, "scope root");
  let root: string;
  try {
    root = await realpath(path.resolve(rootInput));
    if (!(await stat(root)).isDirectory()) throw new ScopeError("scope root must be a directory");
  } catch (e) {
    if (e instanceof ScopeError) throw e;
    throw new ScopeError("scope root does not exist or is not accessible");
  }

  const inside = (real: string): boolean => {
    const rel = path.relative(root, real);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };

  const resolve = async (input: string): Promise<string> => {
    assertPathString(input, "path");
    const real = await realpathLoose(path.resolve(root, input));
    if (!inside(real)) throw new ScopeError("path is outside the scan scope");
    return real;
  };

  const contains = (input: string): Promise<boolean> =>
    resolve(input).then(
      () => true,
      () => false,
    );

  return Object.freeze({ root, resolve, contains });
}

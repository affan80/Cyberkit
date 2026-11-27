/**
 * Safe executable lookup for plugins that wrap an external tool (issue #47).
 *
 * spawn("semgrep") lets the OS search PATH relative to the child's cwd. With
 * the scanned repository as cwd, a PATH containing "." or an empty entry
 * (a leading, trailing or doubled ":") runs the repository's own ./semgrep.
 * So tools are resolved here instead, to an absolute path, by walking PATH and:
 *
 * - skipping empty and relative entries,
 * - skipping candidates whose real path lies inside the scan root,
 * - accepting only regular, executable files.
 *
 * Callers should also spawn with a cwd outside the scanned tree (see
 * neutralCwd()), so nothing the tool resolves relative to its cwd comes from
 * the repository either.
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows needs an extension; .cmd/.bat are skipped because they can't be spawned without a shell. */
const extensions = (name: string): readonly string[] =>
  process.platform === "win32" && path.extname(name) === "" ? [".exe", ".com"] : [""];

export interface ResolveExecutableOptions {
  /** The PATH to search (the child's PATH, not necessarily the host's). */
  readonly pathEnv: string | undefined;
  /** The untrusted tree being scanned: nothing inside it is ever returned. */
  readonly root: string;
}

/**
 * Resolves `name` to an absolute executable path, or undefined when it can't
 * be found safely. A name containing a path separator is the caller's
 * explicit choice: it is resolved against the process cwd and returned as is.
 */
export async function resolveExecutable(name: string, options: ResolveExecutableOptions): Promise<string | undefined> {
  if (name.length === 0) return undefined;
  if (name.includes("/") || name.includes(path.sep)) return path.resolve(name);

  const realRoot = await realpath(options.root).catch(() => path.resolve(options.root));
  for (const dir of (options.pathEnv ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue; // "." and "" mean the child's cwd
    for (const ext of extensions(name)) {
      const candidate = path.join(dir, name + ext);
      if (!(await isExecutableFile(candidate))) continue;
      const [real, realDir] = await Promise.all([realpath(candidate).catch(() => candidate), realpath(dir).catch(() => dir)]);
      if (isInside(realRoot, real) || isInside(realRoot, realDir)) continue;
      return candidate;
    }
  }
  return undefined;
}

/** A working directory for child tools that is never inside the scanned tree. */
export const neutralCwd = (): string => tmpdir();

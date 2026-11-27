/**
 * Writes a report file without following symbolic links planted in an
 * untrusted tree (issue #46).
 *
 * `cyberkit scan . -o cyberkit.sarif` is usually run inside the repository
 * being scanned, so the output path itself, and any directory on the way to
 * it, may be attacker-controlled. The rules:
 *
 * - Every path component below a *root* (the working directory and
 *   the scan root, whichever lexically contain the output) must be a real
 *   directory, never a symlink. Missing directories are created one at a time
 *   so `mkdir -p` never walks through a link either.
 * - The output file itself must not be a symlink (or anything other than a
 *   regular file), wherever it lives.
 * - The report goes to a fresh, exclusively created temp file in the target
 *   directory and is `rename()`d into place. rename() replaces a directory
 *   entry rather than writing through it, so hard links and races on the
 *   final name cannot redirect the bytes, and readers never see half a report.
 * - Just before the rename, the target directory's real path is checked again,
 *   which closes the window for swapping a checked directory for a link.
 */
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export class UnsafeOutputError extends Error {
  override name = "UnsafeOutputError";
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

async function lstatOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await lstat(p);
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

/** `child` relative to `base` when `child` is lexically inside (or equal to) it. */
function inside(base: string, child: string): string | undefined {
  const rel = path.relative(base, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? rel : undefined;
}

/**
 * Ensures `dir` exists and returns its real path. Components below the
 * outermost untrusted root containing `dir` are created/checked one by one and
 * must not be symlinks; anything above it is the user's own choice.
 */
async function prepareDirectory(dir: string, untrustedRoots: readonly string[]): Promise<string> {
  const parts = (rel: string): string[] => (rel === "" ? [] : rel.split(path.sep));
  let base: string | undefined;
  let rel: string[] = [];
  for (const b of untrustedRoots) {
    const r = inside(b, dir);
    if (r !== undefined && (base === undefined || parts(r).length > rel.length)) {
      base = b;
      rel = parts(r);
    }
  }

  if (base === undefined) {
    await mkdir(dir, { recursive: true });
    return realpath(dir);
  }

  await mkdir(base, { recursive: true });
  let current = base;
  for (const part of rel) {
    current = path.join(current, part);
    const st = await lstatOrUndefined(current);
    if (st === undefined) {
      await mkdir(current);
    } else if (st.isSymbolicLink()) {
      throw new UnsafeOutputError(`refusing to write the report through a symbolic link: ${current}`);
    } else if (!st.isDirectory()) {
      throw new UnsafeOutputError(`not a directory: ${current}`);
    }
  }
  return path.join(await realpath(base), ...rel);
}

export interface SafeWriteOptions {
  /**
   * Directories that may hold attacker-controlled content, typically the
   * working directory and the scan root (default: the working directory).
   * The directories themselves are trusted; what is inside them is not.
   */
  readonly untrustedRoots?: readonly string[];
}

export async function writeFileNoFollow(file: string, data: string, options: SafeWriteOptions = {}): Promise<void> {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const name = path.basename(target);
  const bases = (options.untrustedRoots ?? [process.cwd()]).map((b) => path.resolve(b));

  const realDir = await prepareDirectory(dir, bases);

  const existing = await lstatOrUndefined(target);
  if (existing?.isSymbolicLink()) {
    throw new UnsafeOutputError(`refusing to write the report through a symbolic link: ${target}`);
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new UnsafeOutputError(`refusing to replace something that is not a regular file: ${target}`);
  }

  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  // O_EXCL never follows a link at the final component; O_NOFOLLOW is belt and braces (absent on Windows).
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(tmp, flags, existing ? existing.mode & 0o777 : 0o644);
  let renamed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    const written = await handle.stat();
    await handle.close();

    // Re-check that the directory still is where we validated it, and that the
    // temp file is the one we wrote, before putting it in place.
    const tmpNow = await lstat(tmp);
    if ((await realpath(dir)) !== realDir || tmpNow.ino !== written.ino || tmpNow.dev !== written.dev) {
      throw new UnsafeOutputError(`output directory changed while writing the report: ${dir}`);
    }
    await rename(tmp, target);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
}

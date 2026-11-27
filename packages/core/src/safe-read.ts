/**
 * Atomic, size-capped file reads for the scan scope (issue #51).
 *
 * Checking a path and then reading it by path is a TOCTOU race: the file (or
 * a directory above it) can be swapped for a symlink to somewhere else in
 * between, and a file can grow past a size check before it is read. So:
 *
 * 1. open the canonical path once, with O_NOFOLLOW (and O_NONBLOCK so a FIFO
 *    can't hang the scan), and from then on work only on the descriptor;
 * 2. fstat the descriptor: it must be a regular file within the size cap;
 * 3. confirm the descriptor is the file the scope approved: the path must
 *    still be canonical (no symlink anywhere in it) and name the same
 *    dev/inode as the descriptor;
 * 4. read through the descriptor with a hard byte limit, so a file that
 *    grows after the fstat still can't exceed the cap.
 *
 * If step 3 passes, the open file is reachable by a symlink-free path inside
 * the scope, so its bytes are in-scope content no matter what was swapped
 * while it was being opened.
 */
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";

export class UnsafeReadError extends Error {
  override name = "UnsafeReadError";
}

export class FileTooLargeError extends Error {
  override name = "FileTooLargeError";
  constructor(readonly maxBytes: number) {
    super(`file is larger than ${maxBytes} bytes`);
  }
}

const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function readCapped(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new FileTooLargeError(maxBytes);
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Reads `canonicalPath` (already realpath-resolved and approved by the
 * caller) as UTF-8, atomically with respect to that approval.
 * Throws the open() error (e.g. ENOENT) when the file is missing.
 */
export async function readFileAtomic(canonicalPath: string, maxBytes: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, FLAGS);
  } catch (e) {
    // O_NOFOLLOW reports a symlink at the final component as ELOOP (EMLINK on some BSDs).
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafeReadError("file was replaced by a symbolic link");
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new UnsafeReadError("not a regular file");
    if (st.size > maxBytes) throw new FileTooLargeError(maxBytes);

    const [real, byPath] = await Promise.all([realpath(canonicalPath), stat(canonicalPath)]);
    if (real !== canonicalPath || byPath.dev !== st.dev || byPath.ino !== st.ino) {
      throw new UnsafeReadError("file changed while it was being opened");
    }
    return (await readCapped(handle, maxBytes)).toString("utf8");
  } finally {
    await handle.close();
  }
}

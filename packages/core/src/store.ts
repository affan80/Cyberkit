/**
 * Append-only JSONL findings store. One finding per line; there is no update
 * or delete API. Every record is verified on the way in and on the way out.
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { type Finding, verifyFinding } from "./finding.js";

export class StoreError extends Error {
  override readonly name = "StoreError";
}

export interface Store {
  append(finding: Finding): Promise<void>;
  /** Writes all findings in one syscall; if any is invalid, nothing is written. */
  appendMany(findings: readonly Finding[]): Promise<void>;
  /** Lazily streams findings, so memory use stays flat on large files. */
  iterate(): AsyncGenerator<Finding, void, undefined>;
  readAll(): Promise<Finding[]>;
  /** Counts records without parsing them. */
  count(): Promise<number>;
}

const isMissing = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

export function createStore(filePath: string): Store {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new StoreError("store path must be a non-empty string without NUL bytes");
  }

  // Serialise appends within this process; O_APPEND keeps separate processes from interleaving bytes.
  let queue: Promise<unknown> = Promise.resolve();
  let dirReady = false;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function* lines(): AsyncGenerator<[text: string, lineNo: number], void, undefined> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    try {
      for await (const text of rl) {
        lineNo++;
        if (text.length > 0) yield [text, lineNo];
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  async function* iterate(): AsyncGenerator<Finding, void, undefined> {
    for await (const [text, lineNo] of lines()) {
      try {
        yield verifyFinding(JSON.parse(text));
      } catch (e) {
        if (e instanceof StoreError) throw e;
        throw new StoreError(`corrupt record at line ${lineNo}: ${e instanceof Error ? e.message : "invalid"}`);
      }
    }
  }

  async function appendMany(findings: readonly Finding[]): Promise<void> {
    if (findings.length === 0) return;
    let data = "";
    findings.forEach((f, i) => {
      try {
        data += `${JSON.stringify(verifyFinding(f))}\n`;
      } catch (e) {
        throw new StoreError(`refusing to store finding #${i}: ${e instanceof Error ? e.message : "invalid"}`);
      }
    });
    await enqueue(async () => {
      if (!dirReady) {
        await mkdir(path.dirname(filePath), { recursive: true });
        dirReady = true;
      }
      await appendFile(filePath, data, { flag: "a", mode: 0o600 });
    });
  }

  async function readAll(): Promise<Finding[]> {
    const out: Finding[] = [];
    for await (const f of iterate()) out.push(f);
    return out;
  }

  async function count(): Promise<number> {
    let n = 0;
    for await (const entry of lines()) n += entry ? 1 : 0;
    return n;
  }

  return Object.freeze({ append: (f: Finding) => appendMany([f]), appendMany, iterate, readAll, count });
}

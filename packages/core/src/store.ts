/**
 * Append-only JSONL findings store. One finding per line; there is no update
 * or delete API. Every record is verified on the way in and on the way out.
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FindingError, type Finding, verifyFinding } from "./finding.js";

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

/**
 * Largest record accepted, in bytes. A plugin finding's message and evidence
 * are capped at 8 KB each, so valid records are far smaller; anything bigger
 * is rejected as soon as the limit is crossed, without buffering the rest (#57).
 */
export const MAX_RECORD_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

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

  /**
   * Streams records with a chunked byte-level splitter. Splitting on 0x0a is
   * safe in UTF-8, and a record over MAX_RECORD_BYTES fails at the moment it
   * crosses the limit (readline would buffer the whole line first).
   */
  async function* lines(): AsyncGenerator<[text: string, lineNo: number], void, undefined> {
    const stream = createReadStream(filePath);
    let parts: Buffer[] = [];
    let pending = 0;
    let lineNo = 1;
    const take = (tail: Buffer): string => {
      const text = Buffer.concat([...parts, tail], pending + tail.length).toString("utf8");
      parts = [];
      pending = 0;
      return text.endsWith("\r") ? text.slice(0, -1) : text;
    };
    const tooLong = (): StoreError => new StoreError(`record at line ${lineNo} exceeds ${MAX_RECORD_BYTES} bytes`);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0;
        for (let nl = chunk.indexOf(NEWLINE, start); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
          if (pending + nl - start > MAX_RECORD_BYTES) throw tooLong();
          const text = take(chunk.subarray(start, nl));
          if (text.length > 0) yield [text, lineNo];
          lineNo++;
          start = nl + 1;
        }
        if (start < chunk.length) {
          pending += chunk.length - start;
          if (pending > MAX_RECORD_BYTES) throw tooLong();
          parts.push(chunk.subarray(start));
        }
      }
      if (pending > 0) {
        const text = take(Buffer.alloc(0));
        if (text.length > 0) yield [text, lineNo];
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
    } finally {
      stream.destroy();
    }
  }

  async function* iterate(): AsyncGenerator<Finding, void, undefined> {
    for await (const [text, lineNo] of lines()) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        // V8's message quotes part of the record, which may hold anything: keep it out.
        throw new StoreError(`corrupt record at line ${lineNo}: invalid JSON`);
      }
      let finding: Finding;
      try {
        finding = verifyFinding(value);
      } catch (e) {
        throw new StoreError(`corrupt record at line ${lineNo}: ${e instanceof FindingError ? e.message : "invalid"}`);
      }
      yield finding;
    }
  }

  async function appendMany(findings: readonly Finding[]): Promise<void> {
    if (findings.length === 0) return;
    let data = "";
    findings.forEach((f, i) => {
      try {
        const record = JSON.stringify(verifyFinding(f));
        if (Buffer.byteLength(record) > MAX_RECORD_BYTES) throw new StoreError(`record exceeds ${MAX_RECORD_BYTES} bytes`);
        data += `${record}\n`;
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

  /** Counts non-empty lines by scanning bytes: nothing is buffered or parsed. */
  async function count(): Promise<number> {
    const stream = createReadStream(filePath);
    let n = 0;
    let lineHasContent = false;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i] as number;
          if (b === NEWLINE) {
            if (lineHasContent) n++;
            lineHasContent = false;
          } else if (b !== 0x0d) {
            lineHasContent = true;
          }
        }
      }
      if (lineHasContent) n++;
    } catch (e) {
      if (!isMissing(e)) throw e;
    } finally {
      stream.destroy();
    }
    return n;
  }

  return Object.freeze({ append: (f: Finding) => appendMany([f]), appendMany, iterate, readAll, count });
}

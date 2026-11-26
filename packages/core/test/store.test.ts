import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFinding } from "../src/finding.js";
import { MAX_RECORD_BYTES, StoreError, createStore } from "../src/store.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cyberkit-store-"));
  file = path.join(dir, "findings.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mk = (n: number) => createFinding({ engine: "e", ruleId: `r${n}`, severity: "low", message: `m${n}`, file: "a.ts", line: n + 1 });

describe("createStore", () => {
  it("reads an empty list when the file does not exist yet", async () => {
    expect(await createStore(file).readAll()).toEqual([]);
  });

  it("appends one JSON object per line", async () => {
    const s = createStore(file);
    await s.append(mk(1));
    await s.append(mk(2));
    const lines = (await readFile(file, "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] as string)).toEqual(mk(1));
  });

  it("round-trips findings in insertion order", async () => {
    const s = createStore(file);
    await s.appendMany([mk(1), mk(2), mk(3)]);
    expect(await s.readAll()).toEqual([mk(1), mk(2), mk(3)]);
  });

  it("is append-only: a second store instance keeps earlier data", async () => {
    await createStore(file).append(mk(1));
    await createStore(file).append(mk(2));
    expect(await createStore(file).readAll()).toEqual([mk(1), mk(2)]);
  });

  it("streams findings lazily with iterate()", async () => {
    const s = createStore(file);
    await s.appendMany([mk(1), mk(2)]);
    const seen: string[] = [];
    for await (const f of s.iterate()) seen.push(f.ruleId);
    expect(seen).toEqual(["r1", "r2"]);
  });

  it("counts findings", async () => {
    const s = createStore(file);
    expect(await s.count()).toBe(0);
    await s.appendMany([mk(1), mk(2)]);
    expect(await s.count()).toBe(2);
  });

  it("appendMany with an empty list writes nothing", async () => {
    const s = createStore(file);
    await s.appendMany([]);
    await expect(stat(file)).rejects.toThrow();
  });

  it("creates the file owner-only (0600) on POSIX", async () => {
    if (process.platform === "win32") return;
    await createStore(file).append(mk(1));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("exposes no update or delete API", () => {
    expect(Object.keys(createStore(file)).sort()).toEqual(["append", "appendMany", "count", "iterate", "readAll"]);
  });

  it("refuses to store a tampered finding and leaves the file untouched", async () => {
    const s = createStore(file);
    await s.append(mk(1));
    const bad = { ...mk(2), message: "tampered" };
    await expect(s.append(bad)).rejects.toThrow(StoreError);
    expect(await s.count()).toBe(1);
  });

  it("appendMany is all-or-nothing when one finding is invalid", async () => {
    const s = createStore(file);
    await expect(s.appendMany([mk(1), { ...mk(2), message: "tampered" }])).rejects.toThrow(StoreError);
    expect(await s.count()).toBe(0);
  });

  it("reports the line number of a corrupt record", async () => {
    await writeFile(file, `${JSON.stringify(mk(1))}\n{not json}\n`);
    await expect(createStore(file).readAll()).rejects.toThrow(/line 2/);
  });

  it("rejects a record that parses but is not a valid finding", async () => {
    await writeFile(file, `${JSON.stringify({ ...mk(1), message: "edited on disk" })}\n`);
    await expect(createStore(file).readAll()).rejects.toThrow(StoreError);
  });

  it("rejects an empty path", () => {
    expect(() => createStore("")).toThrow(StoreError);
  });
});

describe("createStore: bounded reads (#57)", () => {
  it("rejects an over-long record without buffering it", async () => {
    await writeFile(file, `${JSON.stringify(mk(1))}\n{"note":"password=${"x".repeat(50 * 1024 * 1024)}"`);
    const store = createStore(file);
    const before = process.memoryUsage().rss;
    await expect(store.readAll()).rejects.toThrow(new StoreError(`record at line 2 exceeds ${MAX_RECORD_BYTES} bytes`));
    expect(process.memoryUsage().rss - before).toBeLessThan(40 * 1024 * 1024);
  });

  it("splits records correctly across read-chunk boundaries (multi-byte UTF-8 included)", async () => {
    // Many records so line boundaries land at every offset within read chunks.
    const findings = Array.from({ length: 3000 }, (_, i) => createFinding({ engine: "e", ruleId: "r", severity: "low", message: "é".repeat(i % 97) + i }));
    const store = createStore(file);
    await store.appendMany(findings);
    const back = await store.readAll();
    expect(back.map((f) => f.id)).toEqual(findings.map((f) => f.id));
    expect(await store.count()).toBe(3000);
  });

  it("handles CRLF line endings, blank lines and a missing trailing newline", async () => {
    await writeFile(file, `${JSON.stringify(mk(1))}\r\n\r\n\n${JSON.stringify(mk(2))}`);
    const store = createStore(file);
    expect((await store.readAll()).map((f) => f.ruleId)).toEqual(["r1", "r2"]);
    expect(await store.count()).toBe(2);
  });

  it("does not echo record content in JSON errors", async () => {
    await writeFile(file, '{"note": xxxxxxxx-secret-ish}\n');
    await expect(createStore(file).readAll()).rejects.toThrow(new StoreError("corrupt record at line 1: invalid JSON"));
  });

  it("refuses to write a record it could not read back", async () => {
    const huge = createFinding({ engine: "e", ruleId: "r", severity: "low", message: "m".repeat(MAX_RECORD_BYTES) });
    await expect(createStore(file).append(huge)).rejects.toThrow(/exceeds/);
  });

  it("counts records without buffering long lines", async () => {
    await writeFile(file, `${"x".repeat(5 * MAX_RECORD_BYTES)}\n${JSON.stringify(mk(1))}\n`);
    expect(await createStore(file).count()).toBe(2);
  });
});

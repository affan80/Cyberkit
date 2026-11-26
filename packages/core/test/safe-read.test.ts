import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTooLargeError, UnsafeReadError, readFileAtomic } from "../src/safe-read.js";
import { ScopeError, createScope } from "../src/scope.js";
import { scanSupplyChain } from "../src/engines/supply-chain.js";

const posix = process.platform !== "win32";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-read-root-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "cyberkit-read-out-")));
  await writeFile(path.join(outside, "package.json"), JSON.stringify({ dependencies: { "OUTSIDE-SECRET-DEP": "*" } }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("readFileAtomic", () => {
  it("reads a regular file", async () => {
    await writeFile(path.join(root, "a.txt"), "héllo");
    expect(await readFileAtomic(path.join(root, "a.txt"), 100)).toBe("héllo");
  });

  it("throws ENOENT for a missing file", async () => {
    await expect(readFileAtomic(path.join(root, "nope"), 100)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a file over the cap without reading it", async () => {
    await writeFile(path.join(root, "big"), "x".repeat(101));
    await expect(readFileAtomic(path.join(root, "big"), 100)).rejects.toThrow(FileTooLargeError);
    expect(await readFileAtomic(path.join(root, "big"), 101)).toHaveLength(101);
  });

  it("refuses a final symlink (the approved file was swapped for a link)", async () => {
    const p = path.join(root, "package.json");
    await symlink(path.join(outside, "package.json"), p);
    await expect(readFileAtomic(p, 1000)).rejects.toThrow(UnsafeReadError);
  });

  it("refuses when a directory on the approved path was swapped for a link", async () => {
    await mkdir(path.join(root, "sub"));
    const approved = path.join(root, "sub", "package.json");
    await writeFile(approved, "{}");
    await rename(path.join(root, "sub"), path.join(root, "sub-old"));
    await symlink(outside, path.join(root, "sub"));
    await expect(readFileAtomic(approved, 1000)).rejects.toThrow(/changed while it was being opened/);
  });

  it("refuses a directory", async () => {
    await expect(readFileAtomic(root, 1000)).rejects.toThrow(UnsafeReadError);
  });

  it.runIf(posix)("refuses a FIFO without hanging", async () => {
    const fifo = path.join(root, "package.json");
    execFileSync("mkfifo", [fifo]);
    await expect(readFileAtomic(fifo, 1000)).rejects.toThrow(/not a regular file/);
  });
});

describe("scope.readFile", () => {
  it("reads in-scope files and rejects out-of-scope and excluded ones", async () => {
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "vendor"));
    await writeFile(path.join(root, "vendor", "x.json"), "{}");
    const scope = await createScope(root, { exclude: ["vendor"] });
    expect(await scope.readFile("package.json", { maxBytes: 10 })).toBe("{}");
    await expect(scope.readFile("../x", { maxBytes: 10 })).rejects.toThrow(ScopeError);
    await expect(scope.readFile("vendor/x.json", { maxBytes: 10 })).rejects.toThrow(ScopeError);
  });
});

describe.runIf(posix)("supply-chain engine under a symlink-swap race (issue #51)", () => {
  it("never reads a manifest outside the scope", async () => {
    const pj = path.join(root, "package.json");
    const safe = JSON.stringify({ dependencies: { inside: "1.0.0" } });
    await writeFile(pj, safe);
    const scope = await createScope(root);

    let stop = false;
    let n = 0;
    const racer = (async () => {
      while (!stop) {
        await unlink(pj).catch(() => undefined);
        if (n++ % 2) await writeFile(pj, safe).catch(() => undefined);
        else await symlink(path.join(outside, "package.json"), pj).catch(() => undefined);
      }
    })();

    let hits = 0;
    let runs = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      runs++;
      try {
        const findings = await scanSupplyChain(scope);
        if (findings.some((f) => f.message.includes("OUTSIDE-SECRET-DEP"))) hits++;
      } catch {
        // a refused read is the safe outcome
      }
    }
    stop = true;
    await racer;
    expect(runs).toBeGreaterThan(10);
    expect(hits).toBe(0);
  });
});
